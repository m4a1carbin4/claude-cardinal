// 스테이지 음성 관리: 어느 엔진으로 말할지(자동·기기·호스트·끔), 캐릭터 목소리, 대사 줄 생성 큐, 상태·속도 표시
//
// 대사가 오면 line(text) 가 바로 PCM 스트림을 돌려주고(감독 큐에 audio 로 들어감), 생성은 뒤에서 차례로 하나씩 돌며
// 앞 줄이 재생되는 동안 다음 줄을 미리 만듦. 감독이 재생을 멈추면(중단·새 턴) 스트림 cancel → 생성도 abort
import { currentToken } from '../../api';
import {
  deviceCapable,
  hostBackend,
  loadDevice,
  onDeviceFatal,
  streamGenerate,
  TtsHttpError,
  type Backend,
  type BackendKind,
  type DeviceProgress,
  type GenStats,
} from './backend';
import { PCM_MIME, type PcmInput } from './player';
import { engineSpeakers, forgetRegistered, speakerFields, tuningFields, voiceStore, type SavedVoice } from './voices';

export type TtsMode = 'auto' | 'device' | 'host' | 'off';

export interface TtsState {
  mode: TtsMode;
  active: BackendKind | null; // 지금 말하는 엔진
  why: string; // 왜 그 엔진인지·못 쓰는 이유
  host: 'unknown' | 'ok' | 'down' | 'off';
  device:
    | { state: 'idle' | 'unsupported' | 'unavailable' | 'error'; note: string }
    | { state: 'loading'; note: string; progress: number }
    | { state: 'ready'; note: string; bench?: GenStats };
  voice: SavedVoice | null; // 저장한 목소리 중 캐릭터 목소리 (없으면 기본 목소리)
  voices: SavedVoice[];
  last: (GenStats & { backend: BackendKind; underruns?: number }) | null;
  queue: number; // 생성 기다리는·생성 중인 줄
  error: string;
}

const MODE_KEY = 'cardinal.stage.tts';
// 저장한 목소리가 없을 때 캐릭터 목소리 (두 엔진 다 있는 한국어 여성 기본 목소리)
export const FALLBACK_VOICE: SavedVoice = {
  id: '__default',
  name: '기본 (Seoyeon)',
  source: { type: 'default', label: 'Seoyeon ko F 1' },
  language: 'ko',
  speaker_mode: 'reference',
  embedding: null,
  has_clip: false,
  created_at: 0,
  updated_at: 0,
};
// 기기 엔진을 불러온 뒤 이 줄로 시험 생성해 실시간보다 넉넉히 빠른지 봄 (auto)
const BENCH_TEXT = '안녕하세요, 선생님! 오늘도 잘 부탁드려요.';
const BENCH_MAX_RTF = 0.6;

function loadMode(): TtsMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === 'auto' || m === 'device' || m === 'host' || m === 'off') return m;
  } catch {
    // 무시
  }
  return 'auto';
}

interface Job {
  text: string;
  voice: SavedVoice;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  abort: AbortController;
  cancelled: boolean;
}

export class TtsManager {
  state: TtsState = {
    mode: loadMode(),
    active: null,
    why: '',
    host: 'unknown',
    device: { state: 'idle', note: '' },
    voice: null,
    voices: [],
    last: null,
    queue: 0,
    error: '',
  };
  private subs = new Set<(s: TtsState) => void>();
  private device: Backend | null = null;
  private jobs: Job[] = [];
  private running = false;
  private deviceStatus: { engine: boolean; models: boolean; upload: boolean } | null = null;

  constructor() {
    onDeviceFatal((m) => {
      this.device = null;
      this.set({ device: { state: 'error', note: `기기 엔진 멈춤: ${m}` } });
      this.choose();
    });
  }

  subscribe(f: (s: TtsState) => void): () => void {
    this.subs.add(f);
    f(this.state);
    return () => this.subs.delete(f);
  }

  private set(patch: Partial<TtsState>) {
    this.state = { ...this.state, ...patch };
    this.subs.forEach((f) => f(this.state));
  }

  get enabled() {
    return this.state.mode !== 'off' && this.state.active !== null;
  }

  /** 지금 말하는 엔진 (목소리 디자인도 이걸로 미리 듣기) */
  backend(): Backend | null {
    if (this.state.active === 'device') return this.device;
    if (this.state.active === 'host') return hostBackend;
    return null;
  }

  /** 기기 엔진의 상태(올린 음성 변환용 모델이 있는지 등) */
  get deviceFiles() {
    return this.deviceStatus;
  }

  async init() {
    await Promise.all([this.refreshVoices(), this.refreshStatus()]);
    this.choose();
  }

  async refreshVoices() {
    try {
      const { voices, active } = await voiceStore.list();
      this.set({ voices, voice: voices.find((v) => v.id === active) ?? null });
    } catch (e) {
      this.set({ error: `목소리 목록 실패: ${(e as Error).message}` });
    }
  }

  async refreshStatus() {
    try {
      const t = currentToken();
      const r = await fetch('/api/stage/tts/status', { headers: t ? { authorization: `Bearer ${t}` } : {} });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const s = await r.json();
      this.deviceStatus = s.device;
      this.set({ host: !s.host.url ? 'off' : s.host.ok || s.host.managed ? 'ok' : 'down' });
    } catch {
      this.deviceStatus = null;
      this.set({ host: 'down' });
    }
  }

  setMode(mode: TtsMode) {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // 무시
    }
    this.set({ mode });
    if (mode === 'off') this.stopAll();
    this.choose();
  }

  async setVoice(id: string | null) {
    await voiceStore.setActive(id);
    await this.refreshVoices();
  }

  get voice(): SavedVoice {
    return this.state.voice ?? FALLBACK_VOICE;
  }

  // ---- 엔진 고르기 ----

  private choose() {
    const { mode, host } = this.state;
    if (mode === 'off') return this.set({ active: null, why: '음성 끔' });
    const dev = this.state.device;
    if (mode === 'device' || mode === 'auto') {
      if (dev.state === 'ready' && this.device) {
        const bench = dev.bench;
        if (mode === 'device' || !bench || bench.rtf == null || bench.rtf <= BENCH_MAX_RTF || host !== 'ok')
          return this.set({ active: 'device', why: mode === 'device' ? '기기 (직접 고름)' : `기기 (${dev.note})` });
        return this.set({ active: 'host', why: `호스트 (기기가 느림: RTF ${bench.rtf.toFixed(2)})` });
      }
      if (dev.state === 'idle') void this.startDevice();
    }
    if (mode === 'device') {
      const loading = this.state.device.state === 'loading';
      return this.set({ active: null, why: loading ? '기기 엔진 불러오는 중' : `기기 못 씀: ${this.state.device.note}` });
    }
    if (host === 'ok') {
      const d = this.state.device;
      const why = mode === 'host' ? '호스트 (직접 고름)' : d.state === 'loading' ? '호스트 (기기 준비되는 동안)' : `호스트 (${d.note || '기기 못 씀'})`;
      return this.set({ active: 'host', why });
    }
    this.set({ active: null, why: host === 'off' ? '호스트 TTS 꺼짐 · 기기도 못 씀' : '호스트 TTS(zonos3-server) 가 답하지 않음' });
  }

  private async startDevice() {
    if (this.state.device.state !== 'idle') return;
    this.set({ device: { state: 'loading', note: '확인 중', progress: 0 } });
    const cap = await deviceCapable();
    if (!cap.ok) {
      this.set({ device: { state: 'unsupported', note: cap.why } });
      return this.choose();
    }
    if (this.deviceStatus && !(this.deviceStatus.engine && this.deviceStatus.models)) {
      this.set({ device: { state: 'unavailable', note: '서버에 기기 엔진 파일·모델이 없음 (docs/stage.md)' } });
      return this.choose();
    }
    try {
      const t0 = performance.now();
      this.device = await loadDevice((p: DeviceProgress) => {
        const pct = p.total ? (p.loaded / p.total) * 100 : 0;
        const net = p.fetched > 0 ? ` · 받는 중 ${(p.fetched / 1e6).toFixed(0)}MB` : '';
        this.set({ device: { state: 'loading', note: `모델 ${pct.toFixed(0)}%${net}`, progress: pct } });
      });
      this.set({ device: { state: 'loading', note: `시험 생성 중 (불러오기 ${((performance.now() - t0) / 1000).toFixed(1)}초)`, progress: 100 } });
      const fields = await speakerFields(this.device, FALLBACK_VOICE);
      const bench = await streamGenerate(this.device, { text: BENCH_TEXT, language: 'ko', ...fields }, () => {});
      this.set({ device: { state: 'ready', note: `${cap.why} · RTF ${bench.rtf?.toFixed(2) ?? '?'}`, bench } });
    } catch (e) {
      this.device = null;
      this.set({ device: { state: 'error', note: (e as Error).message } });
    }
    this.choose();
  }

  // ---- 대사 생성 ----

  /** 대사 한 줄 → 감독에 넘길 오디오 (생성은 뒤에서 차례로). 말할 수 없으면 undefined (글자만) */
  line(text: string): PcmInput | undefined {
    if (!this.enabled || !text.trim()) return undefined;
    // 이모지·기호만 있는 줄은 읽지 않음
    if (!/[\p{L}\p{N}]/u.test(text)) return undefined;
    const job: Job = { text, voice: this.voice, controller: null, abort: new AbortController(), cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        job.controller = c;
      },
      cancel: () => {
        job.cancelled = true;
        job.abort.abort();
      },
    });
    this.jobs.push(job);
    this.set({ queue: this.jobs.length });
    void this.pump();
    return { stream, mimeType: PCM_MIME, prebuffer: this.state.active === 'device' ? 0.2 : 0.12 };
  }

  /** 목소리 디자인 미리 듣기: 요청 그대로 한 번 생성 (큐 밖). stats 는 생성이 끝나면 */
  preview(b: Backend, body: Record<string, unknown>): { input: PcmInput; stats: Promise<GenStats> } {
    const abort = new AbortController();
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctl = c;
      },
      cancel: () => abort.abort(),
    });
    const stats = streamGenerate(b, body, (f32) => {
      try {
        ctl.enqueue(new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength));
      } catch {
        // 닫힘
      }
    }, abort.signal).then(
      (s) => {
        this.set({ last: { ...s, backend: b.kind } });
        return s;
      },
    ).finally(() => {
      try {
        ctl.close();
      } catch {
        // 닫힘
      }
    });
    return { input: { stream, mimeType: PCM_MIME, prebuffer: 0.12 }, stats };
  }

  /** 생성 중·대기 중인 줄을 모두 버림 (재생 중인 것은 감독 interrupt 로 멈춤) */
  stopAll() {
    for (const j of this.jobs) {
      j.cancelled = true;
      j.abort.abort();
      try {
        j.controller?.close();
      } catch {
        // 이미 닫힘
      }
    }
    this.jobs = [];
    this.set({ queue: 0 });
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs[0];
        if (!job.cancelled) await this.run(job);
        try {
          job.controller?.close();
        } catch {
          // 이미 닫힘 (cancel)
        }
        this.jobs = this.jobs.filter((j) => j !== job);
        this.set({ queue: this.jobs.length });
      }
    } finally {
      this.running = false;
    }
  }

  private async run(job: Job) {
    const b = this.backend();
    if (!b) return;
    const enqueue = (f32: Float32Array) => {
      if (job.cancelled) return;
      try {
        job.controller?.enqueue(new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength));
      } catch {
        // 닫힘
      }
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const body = { text: job.text, ...tuningFields(job.voice), ...(await speakerFields(b, job.voice)) };
        const stats = await streamGenerate(b, body, enqueue, job.abort.signal);
        this.set({ last: { ...stats, backend: b.kind }, error: '' });
        return;
      } catch (e) {
        if (job.cancelled || (e as Error).name === 'AbortError') return;
        // 엔진이 다시 켜져 올린 목소리가 사라졌으면 다시 올리고 한 번 더
        if (attempt === 0 && e instanceof TtsHttpError && e.status >= 400 && e.status < 500) {
          forgetRegistered(b, job.voice);
          await engineSpeakers(b, true).catch(() => {});
          continue;
        }
        this.set({ error: `음성 생성 실패: ${(e as Error).message}` });
        if (b.kind === 'host' && e instanceof TtsHttpError && e.status >= 500) void this.refreshStatus().then(() => this.choose());
        return;
      }
    }
  }
}
