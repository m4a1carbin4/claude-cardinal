// 음성 인식 워커: transformers.js(Whisper)를 여기서만 불러옴 (화면 번들에 안 들어가고, 추론 중에도 화면이 안 멈춤)
import { type AutomaticSpeechRecognitionPipeline, env, pipeline } from '@huggingface/transformers';
import { type AsrDevice, type AsrModelKey, type FromWorker, type ToWorker, modelOf } from './models';

// 모델은 Hugging Face 에서 받고 브라우저 캐시(Cache API)에 둠. 두 번째부터는 다시 안 받음
env.allowLocalModels = false;

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

let devicePromise: Promise<AsrDevice> | null = null;
function detectDevice(): Promise<AsrDevice> {
  devicePromise ??= (async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
    if (!gpu) return 'wasm';
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return 'wasm';
      return adapter.features.has('shader-f16') ? 'webgpu-f16' : 'webgpu';
    } catch {
      return 'wasm';
    }
  })();
  return devicePromise;
}

// 한 번에 모델 하나만 메모리에 둠 (바꾸면 이전 것은 버림)
let current: { key: AsrModelKey; pipe: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

async function load(key: AsrModelKey): Promise<AutomaticSpeechRecognitionPipeline> {
  if (current?.key === key) return current.pipe;
  const old = current;
  const device = await detectDevice();
  post({ type: 'device', device });
  const m = modelOf(key);
  const pipe = (async () => {
    // 이전 모델의 GPU/메모리 정리
    await old?.pipe.then((p) => p.dispose()).catch(() => {});
    const p = (await pipeline('automatic-speech-recognition', m.id, {
      device: device === 'wasm' ? 'wasm' : 'webgpu',
      dtype: m.dtype[device],
      progress_callback: (info) => {
        if (info.status === 'progress_total')
          post({ type: 'progress', model: key, progress: info.progress, loaded: info.loaded, total: info.total });
      },
    })) as AutomaticSpeechRecognitionPipeline;
    post({ type: 'ready', model: key, device });
    return p;
  })();
  current = { key, pipe };
  pipe.catch(() => {
    if (current?.pipe === pipe) current = null;
  });
  return pipe;
}

// 한 번에 하나씩 (WebGPU 세션은 동시에 돌리면 느려지기만 함)
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'load') {
    load(msg.model).catch((err) => post({ type: 'error', message: String(err?.message ?? err) }));
    return;
  }
  if (msg.type === 'transcribe') {
    queue = queue.then(async () => {
      const t0 = performance.now();
      try {
        const pipe = await load(msg.model);
        const long = msg.audio.length > 16_000 * 30;
        const out = await pipe(msg.audio, {
          ...(msg.language ? { language: msg.language } : {}),
          task: 'transcribe',
          // 30초 넘으면 겹쳐 잘라서 (Whisper 한 번 입력이 30초)
          ...(long ? { chunk_length_s: 30, stride_length_s: 5 } : {}),
        });
        const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim();
        post({ type: 'result', id: msg.id, text, ms: Math.round(performance.now() - t0) });
      } catch (err) {
        post({ type: 'error', id: msg.id, message: String((err as Error)?.message ?? err) });
      }
    });
  }
};
