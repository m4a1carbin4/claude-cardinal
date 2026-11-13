// 스트리밍 PCM 재생 → 캐릭터 감독(AgentDirector)의 AudioPlayback. 조각이 오는 대로 한 AudioContext 시간축에 이어 붙여(빈틈 없이)
// 예약하고, analyser 의 소리 크기(level)로 입 모양을 움직임. 다른 소리(파일·URL 등)는 원래 playAudio 로
import { audioContext, playAudio, type AudioInput, type AudioPlayback, type AudioPlayerFactory } from '../../stage';
import { SR } from './backend';

/** AgentEvent.audio 로 넘기는 생성 중인 음성: float32 PCM 바이트 스트림 */
export const PCM_MIME = 'audio/pcm;format=f32;rate=44100';

export interface PcmInput {
  stream: ReadableStream<Uint8Array>;
  mimeType: typeof PCM_MIME;
  /** 첫 조각을 이만큼 늦춰 예약 (생성·네트워크 흔들림 흡수) */
  prebuffer?: number;
}

const isPcm = (i: AudioInput): i is PcmInput =>
  typeof i === 'object' && i !== null && 'stream' in i && (i as { mimeType?: string }).mimeType === PCM_MIME;

export interface PcmPlayback extends AudioPlayback {
  /** 끊김(재생 위치가 받은 소리를 앞질러 버린 횟수) */
  readonly underruns: number;
}

export function playPcm(input: PcmInput): PcmPlayback {
  const ctx = audioContext();
  const gain = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  gain.connect(analyser).connect(ctx.destination);
  const samples = new Float32Array(analyser.fftSize);
  const sources = new Set<AudioBufferSourceNode>();
  const reader = input.stream.getReader();
  let playHead = 0;
  let started = false;
  let finished = false;
  let underruns = 0;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(endTimer);
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        // 이미 끝남
      }
    }
    sources.clear();
    void reader.cancel().catch(() => {}); // 아직 생성 중이면 생성도 멈춤 (speaker.ts)
    setTimeout(() => analyser.disconnect(), 50);
    resolveDone();
  };

  const push = (f32: Float32Array) => {
    if (!started) {
      started = true;
      playHead = ctx.currentTime + (input.prebuffer ?? 0.12);
    } else if (playHead < ctx.currentTime) {
      underruns++;
      playHead = ctx.currentTime + 0.02;
    }
    const buf = ctx.createBuffer(1, f32.length, SR);
    buf.copyToChannel(f32 as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    src.start(playHead);
    playHead += buf.duration;
    sources.add(src);
    src.onended = () => sources.delete(src);
  };

  void (async () => {
    // 바이트 → float32. 4바이트 경계 밖으로 잘린 조각은 다음과 이어 붙임
    let carry = new Uint8Array(0);
    try {
      await ctx.resume().catch(() => {});
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end || finished) break;
        if (!value?.length) continue;
        let data = value;
        if (carry.length) {
          data = new Uint8Array(carry.length + value.length);
          data.set(carry);
          data.set(value, carry.length);
        }
        const usable = data.length - (data.length % 4);
        carry = data.slice(usable);
        if (usable) push(new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + usable)));
      }
    } catch {
      // 생성 실패·취소: 받은 데까지만 재생
    }
    if (finished) return;
    // 마지막 조각이 다 울릴 때까지
    const left = started ? Math.max(0, playHead - ctx.currentTime) : 0;
    endTimer = setTimeout(finish, left * 1000 + 30);
  })();

  return {
    done,
    duration: Promise.resolve(null), // 생성 중이라 길이를 모름 → 말풍선은 기본 속도로 쓰고 소리가 끝날 때까지 둠
    get underruns() {
      return underruns;
    },
    stop: finish,
    level() {
      if (finished) return 0;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      return Math.sqrt(sum / samples.length);
    },
  };
}

/** 스테이지 감독용 플레이어: 생성 중인 PCM 은 playPcm, 그 밖엔 원래 플레이어 */
export const stagePlayer: AudioPlayerFactory = (input) => (isPcm(input) ? playPcm(input) : playAudio(input));
