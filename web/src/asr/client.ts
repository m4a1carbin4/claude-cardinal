// 음성 입력: 마이크 녹음 + 워커(Whisper)로 글자 만들기. 워커는 페이지에 하나만 두고 세션 화면들이 같이 씀
import { type AsrDevice, type AsrModelKey, type FromWorker, defaultAsrLanguage } from './models';

export interface AsrStatus {
  device?: AsrDevice;
  loading?: { model: AsrModelKey; progress: number; loaded: number; total: number };
  ready?: AsrModelKey;
  error?: string;
}

let worker: Worker | null = null;
let status: AsrStatus = {};
const listeners = new Set<(s: AsrStatus) => void>();
const waiting = new Map<number, { resolve: (r: { text: string; ms: number }) => void; reject: (e: Error) => void }>();
let nextId = 1;

function setStatus(patch: Partial<AsrStatus>) {
  status = { ...status, ...patch };
  for (const l of listeners) l(status);
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    switch (m.type) {
      case 'device':
        setStatus({ device: m.device });
        break;
      case 'progress':
        setStatus({ loading: { model: m.model, progress: m.progress, loaded: m.loaded, total: m.total }, error: undefined });
        break;
      case 'ready':
        setStatus({ ready: m.model, device: m.device, loading: undefined, error: undefined });
        break;
      case 'result':
        waiting.get(m.id)?.resolve({ text: m.text, ms: m.ms });
        waiting.delete(m.id);
        break;
      case 'error':
        if (m.id !== undefined) {
          waiting.get(m.id)?.reject(new Error(m.message));
          waiting.delete(m.id);
        }
        setStatus({ error: m.message, loading: undefined });
        break;
    }
  };
  return worker;
}

export function subscribeAsr(fn: (s: AsrStatus) => void): () => void {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

export function preloadAsr(model: AsrModelKey) {
  if (status.ready === model) return;
  getWorker().postMessage({ type: 'load', model });
}

export function transcribe(audio: Float32Array, model: AsrModelKey, language: string): Promise<{ text: string; ms: number }> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ type: 'transcribe', id, model, audio, language }, [audio.buffer]);
  });
}

// 마이크는 보안 컨텍스트(https, localhost/127.0.0.1)에서만 열림
export const micSupported = () => !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

export interface Recording {
  stop: () => Promise<Float32Array>; // 16kHz 모노
  cancel: () => void;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
  rec.start();
  const release = () => stream.getTracks().forEach((t) => t.stop());
  return {
    async stop() {
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      release();
      const buf = await new Blob(chunks, { type: rec.mimeType }).arrayBuffer();
      // 16kHz 로 디코딩하면 브라우저가 알아서 리샘플링함 (Whisper 입력 형식)
      const ctx = new AudioContext({ sampleRate: 16_000 });
      try {
        const audio = await ctx.decodeAudioData(buf);
        return new Float32Array(audio.getChannelData(0));
      } finally {
        void ctx.close();
      }
    },
    cancel() {
      if (rec.state !== 'inactive') rec.stop();
      release();
    },
  };
}

// 이 브라우저에만 기억하는 설정 (세션과 상관없음)
export interface AsrSettings {
  model: AsrModelKey;
  language: string;
  autoSend: boolean;
}

const KEY = 'cardinal.asr';
export function loadAsrSettings(): AsrSettings {
  const defaults: AsrSettings = { model: 'turbo', language: defaultAsrLanguage(), autoSend: false };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

export function saveAsrSettings(s: AsrSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 저장 안 돼도 이번엔 씀
  }
}
