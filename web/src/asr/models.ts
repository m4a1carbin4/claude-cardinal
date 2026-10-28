// 브라우저 안 음성 인식(Whisper, transformers.js) 모델 목록. 워커와 화면이 같이 씀
import type { DataType } from '@huggingface/transformers';

export type AsrModelKey = 'base' | 'small' | 'turbo';
export type AsrDevice = 'webgpu-f16' | 'webgpu' | 'wasm';

type Dtype = DataType | Record<string, DataType>;

export interface AsrModel {
  key: AsrModelKey;
  id: string;
  label: string;
  // 장치마다 받을 파일 (onnx-community 저장소에 있는 것만). 크기는 실측 (MB, encoder + decoder_merged)
  dtype: Record<AsrDevice, Dtype>;
  size: Record<AsrDevice, number>;
}

export const ASR_MODELS: AsrModel[] = [
  {
    key: 'base',
    id: 'onnx-community/whisper-base',
    label: 'Whisper base — 빠름',
    dtype: {
      'webgpu-f16': { encoder_model: 'fp16', decoder_model_merged: 'q4' },
      webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      wasm: 'q8',
    },
    size: { 'webgpu-f16': 165, webgpu: 206, wasm: 77 },
  },
  {
    key: 'small',
    id: 'onnx-community/whisper-small',
    label: 'Whisper small — 중간',
    dtype: {
      'webgpu-f16': { encoder_model: 'fp16', decoder_model_merged: 'q4' },
      webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      wasm: 'q8',
    },
    size: { 'webgpu-f16': 410, webgpu: 586, wasm: 249 },
  },
  {
    key: 'turbo',
    id: 'onnx-community/whisper-large-v3-turbo',
    label: 'Whisper large-v3-turbo — 정확 (WebGPU 권장)',
    dtype: {
      'webgpu-f16': { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' },
      webgpu: { encoder_model: 'q4', decoder_model_merged: 'q4' },
      wasm: 'q8',
    },
    size: { 'webgpu-f16': 564, webgpu: 759, wasm: 1085 },
  },
];

// 브라우저 언어(navigator.language) → Whisper 언어 이름. 목록에 없으면 영어
export function defaultAsrLanguage(): string {
  const code = (navigator.language || 'en').slice(0, 2).toLowerCase();
  const byCode: Record<string, string> = {
    ko: 'korean', en: 'english', ja: 'japanese', zh: 'chinese', es: 'spanish',
    fr: 'french', de: 'german', ru: 'russian', vi: 'vietnamese',
  };
  return byCode[code] ?? 'english';
}

export const modelOf = (key: AsrModelKey) => ASR_MODELS.find((m) => m.key === key) ?? ASR_MODELS[0];

// Whisper 언어. transformers.js 는 영어 이름으로 받음.
// 비우면 자동이지만 실측으로 한국어 음성을 영어 문장으로 내놓음 (영어로 치우침) → 기본은 브라우저 언어
export const ASR_LANGUAGES: { id: string; label: string }[] = [
  { id: '', label: '자동 (불안정, 영어로 치우침)' },
  { id: 'korean', label: '한국어' },
  { id: 'english', label: 'English' },
  { id: 'japanese', label: '日本語' },
  { id: 'chinese', label: '中文' },
  { id: 'spanish', label: 'Español' },
  { id: 'french', label: 'Français' },
  { id: 'german', label: 'Deutsch' },
  { id: 'russian', label: 'Русский' },
  { id: 'vietnamese', label: 'Tiếng Việt' },
];

// 워커 ↔ 화면 메시지
export type ToWorker =
  | { type: 'load'; model: AsrModelKey }
  | { type: 'transcribe'; id: number; model: AsrModelKey; audio: Float32Array; language: string };

export type FromWorker =
  | { type: 'device'; device: AsrDevice }
  | { type: 'progress'; model: AsrModelKey; progress: number; loaded: number; total: number }
  | { type: 'ready'; model: AsrModelKey; device: AsrDevice }
  | { type: 'result'; id: number; text: string; ms: number }
  | { type: 'error'; id?: number; message: string };
