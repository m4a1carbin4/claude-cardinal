// 마이크를 열어 둔 채 16kHz 프레임(32ms)으로 받아서 말소리 구간을 잘라 넘김. 스테이지 음성 입력의 "누르는 동안"·"계속 듣기"용.
// 캡처(AudioWorklet 에서 16kHz 로 줄이기)와 말 끝 판단(멈춤 길이, 짧은 말엔 더 기다림, 앞부분 pre-roll)은
// ming-voice(github.com/JMS1717/ming-voice)를 본뜸. 그쪽은 서버에서 Silero VAD + Smart Turn 으로 하지만
// 여기선 브라우저 안에서 소리 크기(배경 소음 대비)로 함. 소리는 서버로 안 감 (글자만 감)

const RATE = 16_000;
const FRAME = 512;
const FRAME_MS = (FRAME / RATE) * 1000; // 32ms
const PREROLL = 10; // 320ms: 말 시작이 잡히기 전 소리도 붙임
const ONSET = 3; // 이만큼(약 100ms) 연달아 크면 말 시작
const WARMUP = 15; // 처음 약 0.5초는 배경 소음만 잼
const TAIL = 6; // 끝 침묵은 이만큼(약 200ms)만 남김 (길면 Whisper 가 없는 말을 지어냄)
const MIN_SPEECH_MS = 300; // 이보다 짧으면 버림 (기침, 딸깍)
const SHORT_MS = 1000; // 이보다 짧은 말은 끝을 더 기다림 ("저기…" 하고 멈추는 경우)
const SHORT_EXTRA_MS = 250;
const MAX_UTTER_MS = 28_000; // Whisper 한 번 입력(30초) 안쪽에서 끊음
const MAX_MANUAL_MS = 300_000; // 누르는 동안·버튼: 5분

// 마이크 소리를 16kHz 로 줄여(구간 평균) 512 샘플씩 넘김
const WORKLET = `
class Cap extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / ${RATE}; this.acc = 0; this.sum = 0; this.cnt = 0; this.buf = new Float32Array(${FRAME}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.cnt++; this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        this.buf[this.n++] = this.sum / this.cnt; this.sum = 0; this.cnt = 0;
        if (this.n === ${FRAME}) { this.port.postMessage(this.buf.buffer, [this.buf.buffer]); this.buf = new Float32Array(${FRAME}); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('cardinal-cap', Cap);`;

export const listenSupported = () => !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== 'undefined';

export interface VadOptions {
  endMs: number; // 이만큼 조용하면 말 끝
  sensitivity: number; // 0–1, 높을수록 작은 소리도 말로 봄
}

export interface ListenerHooks {
  onLevel?: (level: number) => void; // 0–1 (dB 기준), 프레임마다
  onSpeech?: (speaking: boolean) => void; // 계속 듣기: 말 시작/끝
  onUtterance?: (audio: Float32Array) => void; // 계속 듣기: 한 마디 (16kHz 모노)
}

const concat = (frames: Float32Array[]) => {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
};

export class VoiceListener {
  vad: VadOptions | null = null; // null 이면 begin()/end() 로만 받음
  private manual = false;
  private frames: Float32Array[] = [];
  private preroll: Float32Array[] = [];
  private noise = 0;
  private warm = 0;
  private inSpeech = false;
  private onset = 0;
  private loud = 0;
  private pause = 0;
  private speechLevel = 0;

  private constructor(
    private hooks: ListenerHooks,
    private stream: MediaStream,
    private ctx: AudioContext,
    private nodes: AudioNode[],
  ) {}

  static async open(hooks: ListenerHooks): Promise<VoiceListener> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const src = ctx.createMediaStreamSource(stream);
      const cap = new AudioWorkletNode(ctx, 'cardinal-cap');
      // 소리는 안 내고 워클릿만 계속 돌게
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(cap);
      cap.connect(mute);
      mute.connect(ctx.destination);
      const l = new VoiceListener(hooks, stream, ctx, [src, cap, mute]);
      cap.port.onmessage = (e: MessageEvent<ArrayBuffer>) => l.onFrame(new Float32Array(e.data));
      await ctx.resume();
      return l;
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      throw e;
    }
  }

  // 누르는 동안·버튼: 여기서부터 모음 (마이크가 이미 열려 있었으면 바로 앞 320ms 도 붙임)
  begin() {
    this.resetSpeech();
    this.manual = true;
    this.frames = [...this.preroll];
  }

  end(): Float32Array {
    this.manual = false;
    const audio = concat(this.frames);
    this.frames = [];
    return audio;
  }

  get recording() {
    return this.manual;
  }

  close() {
    this.stream.getTracks().forEach((t) => t.stop());
    for (const n of this.nodes) n.disconnect();
    void this.ctx.close();
    this.hooks = {};
  }

  private resetSpeech() {
    if (this.inSpeech) this.hooks.onSpeech?.(false);
    this.inSpeech = false;
    this.onset = this.loud = this.pause = 0;
    this.frames = [];
  }

  private onFrame(f: Float32Array) {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length);
    this.hooks.onLevel?.(Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-9) + 60) / 50)));
    this.preroll.push(f);
    if (this.preroll.length > PREROLL) this.preroll.shift();

    if (this.manual) {
      this.frames.push(f);
      if (this.frames.length * FRAME_MS > MAX_MANUAL_MS) this.frames.shift();
      return;
    }
    if (this.warm < WARMUP) {
      this.warm++;
      this.noise += (rms - this.noise) / this.warm;
      return;
    }
    if (!this.vad) {
      this.trackNoise(rms);
      return;
    }
    this.detect(f, rms, this.vad);
  }

  // 배경 소음: 내려갈 땐 빨리, 올라갈 땐 천천히 따라감 (말소리에 끌려 올라가지 않게)
  private trackNoise(rms: number) {
    this.noise = rms < this.noise ? this.noise * 0.8 + rms * 0.2 : this.noise * 0.995 + rms * 0.005;
  }

  private detect(f: Float32Array, rms: number, v: VadOptions) {
    const s = Math.min(1, Math.max(0, v.sensitivity));
    // 민감도 0 → 소음의 6배 + 최소 0.02, 1 → 2배 + 최소 0.004
    const start = Math.max(this.noise * (6 - 4 * s), 0.02 - 0.016 * s);
    if (!this.inSpeech) {
      this.trackNoise(rms);
      this.onset = rms > start ? this.onset + 1 : 0;
      if (this.onset >= ONSET) {
        this.inSpeech = true;
        this.frames = [...this.preroll];
        this.loud = this.onset;
        this.speechLevel = rms;
        this.pause = 0;
        this.hooks.onSpeech?.(true);
      }
      return;
    }
    this.frames.push(f);
    // 말하는 크기보다 20dB 쯤 작거나 시작 기준 근처면 조용한 것
    const quiet = rms < Math.max(start * 0.6, this.speechLevel * 0.1);
    if (quiet) this.pause++;
    else {
      this.loud++;
      this.speechLevel += (rms - this.speechLevel) / Math.min(this.loud, 50);
      this.pause = 0;
    }
    const speechMs = this.loud * FRAME_MS;
    const endMs = v.endMs + (speechMs < SHORT_MS ? SHORT_EXTRA_MS : 0);
    if (this.pause * FRAME_MS >= endMs) this.finish(this.frames.length - Math.max(0, this.pause - TAIL), speechMs);
    else if (this.frames.length * FRAME_MS >= MAX_UTTER_MS) this.finish(this.frames.length, speechMs);
  }

  private finish(keep: number, speechMs: number) {
    const audio = concat(this.frames.slice(0, keep));
    this.resetSpeech();
    if (speechMs >= MIN_SPEECH_MS) this.hooks.onUtterance?.(audio);
  }
}
