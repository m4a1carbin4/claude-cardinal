// 스테이지 음성(ZONOS3-Mini) 엔진 두 가지. 둘 다 같은 v2 API(/v2/generate, /v2/speakers …)를 말해서 위쪽 코드는 같이 씀
//  device: 이 브라우저 WebGPU 로 생성 (upstream servers/web 의 engine.js, 웹 워커 안. localFetch 가 v2 API 를 흉내 냄)
//          엔진 파일·모델 조각은 카디널 서버가 /stage-tts/engine, /stage-tts/models 로 내려줌. 처음엔 ~1GB 받고 Cache Storage 에 둠
//  host:   카디널 서버가 이 컴퓨터의 zonos3-server(CPU) 로 넘김 (/api/stage/tts/v2/*, 받는 대로 흘려보냄)
import { currentToken } from '../../api';

export type BackendKind = 'device' | 'host';

export interface Backend {
  kind: BackendKind;
  /** path 는 /v2/… */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export const SR = 44100; // API 의 PCM: float32 little-endian 모노 44.1kHz
// zonos3-server 는 업로드한 목소리를 X-TTS-Session-ID 별로 둠. 호스트는 카디널 서버가 덮어씀(모두 같은 세션)
const SESSION = 'cardinal-stage';

export class TtsHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function ok(r: Response): Promise<Response> {
  if (r.ok) return r;
  let msg = `HTTP ${r.status}`;
  try {
    const j = await r.json();
    msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j);
  } catch {
    // 본문이 JSON 아님
  }
  throw new TtsHttpError(r.status, msg);
}

export async function getJson<T>(b: Backend, path: string, init?: RequestInit): Promise<T> {
  return (await ok(await b.fetch(path, init))).json() as Promise<T>;
}

export const postJson = <T>(b: Backend, path: string, body: unknown, signal?: AbortSignal) =>
  getJson<T>(b, path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, signal });

function withHeaders(init: RequestInit | undefined, extra: Record<string, string>): RequestInit {
  const h = new Headers(init?.headers);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return { ...init, headers: h };
}

export const hostBackend: Backend = {
  kind: 'host',
  fetch(path, init) {
    const t = currentToken();
    return fetch(`/api/stage/tts${path}`, withHeaders(init, t ? { authorization: `Bearer ${t}` } : {}));
  },
};

// ---- 기기 (WebGPU) ----

export interface DeviceProgress {
  models: string[];
  loaded: number;
  total: number;
  fetched: number;
}

interface EngineModule {
  engine: {
    init(progress: (p: DeviceProgress) => void, opts?: { base?: string; cache?: boolean }): Promise<void>;
    onFatal(cb: (m: string) => void): void;
    onEncoderProgress(cb: (p: DeviceProgress) => void): void;
  };
  localFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** 이 브라우저에서 기기 생성을 해 볼 만한지 (WebGPU·어댑터 한도). 실제로 빠른지는 불러온 뒤 시험 생성으로 봄 */
export async function deviceCapable(): Promise<{ ok: boolean; why: string }> {
  if (!window.isSecureContext) return { ok: false, why: 'https 또는 localhost 주소가 아님' };
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: object): Promise<any> } }).gpu;
  if (!gpu) return { ok: false, why: '이 브라우저엔 WebGPU 가 없음' };
  let adapter: any;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch {
    adapter = null;
  }
  if (!adapter) return { ok: false, why: 'WebGPU 어댑터 없음' };
  // 시험용: localStorage cardinal.stage.tts.forceDevice=1 이면 소프트웨어 WebGPU 라도 씀 (GPU 없는 헤드리스 확인용, 아주 느림)
  let force = false;
  try {
    force = localStorage.getItem('cardinal.stage.tts.forceDevice') === '1';
  } catch {
    // 무시
  }
  if ((adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter) && !force) return { ok: false, why: '소프트웨어 WebGPU (느림)' };
  const lim = adapter.limits;
  const MiB = 1024 * 1024;
  // 모델 텐서(백본 조각 하나 ~100MB)를 한 버퍼에 올려야 함
  if (lim.maxStorageBufferBindingSize < 128 * MiB || lim.maxBufferSize < 256 * MiB)
    return { ok: false, why: `GPU 버퍼 한도가 작음 (${Math.round(lim.maxStorageBufferBindingSize / MiB)}MiB)` };
  const ua = (navigator as unknown as { userAgentData?: { mobile?: boolean } }).userAgentData;
  const vendor = adapter.info?.vendor ? ` · ${adapter.info.vendor}${adapter.info.architecture ? ` ${adapter.info.architecture}` : ''}` : '';
  return { ok: true, why: `WebGPU${vendor}${ua?.mobile ? ' (모바일)' : ''}` };
}

let devicePromise: Promise<Backend> | null = null;
const fatalSubs = new Set<(m: string) => void>();
const encoderSubs = new Set<(p: DeviceProgress) => void>();

export const onDeviceFatal = (cb: (m: string) => void) => (fatalSubs.add(cb), () => fatalSubs.delete(cb));
/** 올린 음성을 기기에서 처음 화자로 바꿀 때 받는 encoder·teacher (~2.7GB) 진행 */
export const onDeviceEncoder = (cb: (p: DeviceProgress) => void) => (encoderSubs.add(cb), () => encoderSubs.delete(cb));

/** 기기 엔진을 불러옴 (한 번만, 실패하면 다음에 다시). 모델은 Cache Storage 에 남아서 두 번째부턴 빠름 */
export function loadDevice(progress: (p: DeviceProgress) => void): Promise<Backend> {
  devicePromise ??= (async () => {
    // spine 리소스처럼 워커는 헤더를 못 붙임 → 토큰은 쿠키(경로 /stage-tts, main.ts 가 심음)
    const url = new URL('/stage-tts/engine/engine.js', location.href).href;
    const mod = (await import(/* @vite-ignore */ url)) as EngineModule;
    mod.engine.onFatal((m) => fatalSubs.forEach((f) => f(m)));
    mod.engine.onEncoderProgress((p) => encoderSubs.forEach((f) => f(p)));
    await mod.engine.init(progress, { base: new URL('/stage-tts/models/', location.href).href });
    return {
      kind: 'device' as const,
      fetch: (path: string, init?: RequestInit) => mod.localFetch(path, withHeaders(init, { 'X-TTS-Session-ID': SESSION })),
    };
  })().catch((e) => {
    devicePromise = null;
    throw e;
  });
  return devicePromise;
}

// ---- 스트리밍 생성 ----

export interface GenStats {
  ttfa: number; // 요청 → 첫 소리 (ms)
  genMs: number;
  audioSec: number;
  rtf: number | null; // 생성 시간 / 소리 길이 (1 보다 작아야 실시간)
  seed: string | null;
}

/** POST /v2/generate (stream, pcm) → 오는 대로 onChunk(float32). 4바이트 경계에 안 맞게 잘려 와도 이어 붙임 */
export async function streamGenerate(
  b: Backend,
  body: Record<string, unknown>,
  onChunk: (f32: Float32Array) => void,
  signal?: AbortSignal,
): Promise<GenStats> {
  const t0 = performance.now();
  const r = await ok(
    await b.fetch('/v2/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true, format: 'pcm' }),
      signal,
    }),
  );
  const reader = r.body!.getReader();
  let carry = new Uint8Array(0);
  let samples = 0;
  let ttfa: number | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      ttfa ??= performance.now() - t0;
      let data = value;
      if (carry.length) {
        data = new Uint8Array(carry.length + value.length);
        data.set(carry);
        data.set(value, carry.length);
      }
      const usable = data.length - (data.length % 4);
      carry = data.slice(usable);
      if (usable) {
        const f32 = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + usable));
        samples += f32.length;
        onChunk(f32);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const genMs = performance.now() - t0;
  const audioSec = samples / SR;
  return { ttfa: ttfa ?? genMs, genMs, audioSec, rtf: audioSec > 0 ? genMs / 1000 / audioSec : null, seed: r.headers.get('X-Seed') };
}

// ---- 소리 도우미 ----

/** 브라우저가 읽는 음성 파일 → 모노 44.1kHz float32 (maxSec 까지) */
export async function decodeToMono(blob: Blob, maxSec = 30): Promise<Float32Array> {
  const probe = new OfflineAudioContext(1, 1, SR);
  const audio = await probe.decodeAudioData(await blob.arrayBuffer());
  const len = Math.min(audio.length, Math.floor(maxSec * audio.sampleRate));
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil((len * SR) / audio.sampleRate)), SR);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

/** float32 모노 → 16비트 wav */
export function wavBytes(f32: Float32Array, sr = SR): Uint8Array {
  const n = f32.length;
  const b = new ArrayBuffer(44 + n * 2);
  const v = new DataView(b);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, f32[i])) * 0x7fff, true);
  return new Uint8Array(b);
}

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 화자 임베딩 → .npy (float32, (D,)). POST /v2/speakers 의 speaker_embedding_base64 로 */
export function npyBytes(v: ArrayLike<number>): Uint8Array {
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${v.length},), }`;
  const pre = 10; // 매직 6 + 버전 2 + 길이 2
  header += ' '.repeat(63 - ((pre + header.length) % 64)) + '\n';
  const out = new Uint8Array(pre + header.length + v.length * 4);
  out.set([0x93, ...'NUMPY'].map((c) => (typeof c === 'number' ? c : c.charCodeAt(0))));
  out[6] = 1;
  out[7] = 0;
  out[8] = header.length & 0xff;
  out[9] = header.length >> 8;
  for (let i = 0; i < header.length; i++) out[pre + i] = header.charCodeAt(i);
  new Float32Array(out.buffer, pre + header.length, v.length).set(Array.from(v));
  return out;
}

/** zonos3 의 화자 섞기 (servers/web/src/api/speakers.ts slerp 와 같은 식) */
export function slerp(v0: ArrayLike<number>, v1: ArrayLike<number>, t: number): number[] {
  const n = (v: ArrayLike<number>) => Math.sqrt(Array.from(v).reduce((a, x) => a + x * x, 0)) + 1e-8;
  const n0 = n(v0);
  const n1 = n(v1);
  let dot = 0;
  for (let i = 0; i < v0.length; i++) dot += (v0[i] / n0) * (v1[i] / n1);
  const omega = Math.acos(Math.min(1, Math.max(-1, dot)));
  const out: number[] = [];
  if (omega < 1e-6) {
    for (let i = 0; i < v0.length; i++) out.push((1 - t) * v0[i] + t * v1[i]);
    return out;
  }
  const so = Math.sin(omega);
  const a = Math.sin((1 - t) * omega) / so;
  const c = Math.sin(t * omega) / so;
  for (let i = 0; i < v0.length; i++) out.push(a * v0[i] + c * v1[i]);
  return out;
}
