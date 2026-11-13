// 목소리: 엔진의 기본 목소리 + 카디널 서버에 저장한 목소리(레시피). 저장한 목소리를 어느 엔진에서든 쓰게 화자 필드로 바꿈
import { ApiError, currentToken } from '../../api';
import { b64, getJson, npyBytes, postJson, type Backend, type BackendKind } from './backend';

/** 엔진의 /v2/speakers 한 줄 */
export interface EngineSpeaker {
  id: string;
  label: string;
  scope: string;
  is_default: boolean;
  has_preview: boolean;
  speaker_modes: string[];
  original_name?: string | null;
}

export type SpeakerMode = 'embedding' | 'reference';

export type VoiceSource =
  | { type: 'default'; label: string } // 엔진 기본 목소리 (두 엔진이 같은 이름으로 가짐)
  | { type: 'blend'; a: string; b: string; t: number } // 두 목소리 섞기 (slerp). 저장할 땐 섞은 임베딩도 같이
  | { type: 'clip' }; // 올리거나 녹음한 참고 음성 (서버에 reference.wav)

/** 조절값: condition_values (말 빠르기 등, 체크포인트의 condition rows) + 샘플링 */
export interface VoiceTuning {
  language: string;
  speaker_mode?: SpeakerMode;
  condition_values?: { speaking_rate?: number; loudness?: number; fmax?: number };
  controls?: Record<string, number>; // 스티어링 번들이 있는 엔진만 (GET /v2/controls)
  params?: { temperature?: number; seed?: number | null; speaker_cfg_scale?: number };
}

export interface SavedVoice extends VoiceTuning {
  id: string;
  name: string;
  source: VoiceSource;
  embedding: number[] | null;
  has_clip: boolean;
  test_text?: string;
  created_at: number;
  updated_at: number;
}

// ---- 카디널 서버 목소리 저장소 (/api/stage/voices) ----

async function cardinal<T>(path: string, init: RequestInit = {}): Promise<T> {
  const h = new Headers(init.headers);
  const t = currentToken();
  if (t) h.set('authorization', `Bearer ${t}`);
  if (typeof init.body === 'string') h.set('content-type', 'application/json');
  const r = await fetch(`/api/stage/voices${path}`, { ...init, headers: h });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new ApiError(r.status, typeof j.detail === 'string' ? j.detail : `HTTP ${r.status}`);
  }
  return (r.headers.get('content-type')?.includes('json') ? r.json() : r.blob()) as Promise<T>;
}

export const voiceStore = {
  list: () => cardinal<{ voices: SavedVoice[]; active: string | null }>(''),
  save: (recipe: Partial<SavedVoice> & { name: string; source: VoiceSource }, clipWav?: Uint8Array) =>
    cardinal<SavedVoice>('', { method: 'POST', body: JSON.stringify({ recipe, clip_base64: clipWav ? b64(clipWav) : null }) }),
  remove: (id: string) => cardinal<{ ok: boolean }>(`/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setActive: (id: string | null) => cardinal<{ active: string | null }>('/active', { method: 'PUT', body: JSON.stringify({ id }) }),
  clip: (id: string) => cardinal<Blob>(`/${encodeURIComponent(id)}/clip`),
};

// ---- 엔진별 화자 목록·등록 ----

const speakerCache = new Map<BackendKind, Promise<EngineSpeaker[]>>();

export function engineSpeakers(b: Backend, fresh = false): Promise<EngineSpeaker[]> {
  let p = fresh ? undefined : speakerCache.get(b.kind);
  if (!p) {
    p = getJson<{ speakers: EngineSpeaker[] }>(b, '/v2/speakers').then((r) => r.speakers);
    p.catch(() => speakerCache.delete(b.kind));
    speakerCache.set(b.kind, p);
  }
  return p;
}

export async function speakerEmbedding(b: Backend, id: string): Promise<number[]> {
  return (await getJson<{ embedding: number[] }>(b, `/v2/speakers/${encodeURIComponent(id)}/embedding`)).embedding;
}

/** 참고 음성(wav) 이나 임베딩(.npy) 을 엔진 세션에 올림 → 화자 id */
export async function registerSpeaker(
  b: Backend,
  label: string,
  what: { wav: Uint8Array } | { embedding: ArrayLike<number> },
): Promise<EngineSpeaker> {
  const body =
    'wav' in what
      ? { label, speaker_audio_base64: b64(what.wav), speaker_audio_name: 'reference.wav' }
      : { label, speaker_embedding_base64: b64(npyBytes(what.embedding)), speaker_embedding_name: 'embedding.npy' };
  const s = await postJson<EngineSpeaker>(b, '/v2/speakers', body);
  speakerCache.delete(b.kind);
  return s;
}

// 저장한 목소리 → 엔진 세션 화자 id. 엔진(zonos3-server) 이 다시 켜지면 세션이 비므로 실패하면 forget 하고 다시 올림
const registered = new Map<string, Promise<{ id: string; mode: SpeakerMode }>>();
const regKey = (b: Backend, v: SavedVoice) => `${b.kind}:${v.id}:${v.updated_at}`;

export function forgetRegistered(b: Backend, v: SavedVoice) {
  registered.delete(regKey(b, v));
  speakerCache.delete(b.kind);
}

/** 저장한 목소리 → 이 엔진에서 쓸 생성 요청의 화자 필드 */
export async function speakerFields(b: Backend, v: SavedVoice): Promise<Record<string, unknown>> {
  if (v.source.type === 'default') {
    const label = v.source.label;
    const s = (await engineSpeakers(b)).find((x) => x.is_default && x.label === label);
    if (s) {
      const mode = v.speaker_mode && s.speaker_modes.includes(v.speaker_mode) ? v.speaker_mode : s.speaker_modes[0];
      return { speaker_embedding_id: s.id, speaker_mode: mode };
    }
    if (!v.embedding) throw new Error(`이 엔진엔 기본 목소리 “${label}” 가 없음`);
  }
  const key = regKey(b, v);
  let p = registered.get(key);
  if (!p) {
    p = (async () => {
      // 참고 음성: 호스트는 음성 그대로 (reference 모드도 됨). 기기는 임베딩만 (음성 → 화자 변환에 ~2.7GB 를 더 받아야 해서)
      if (v.source.type === 'clip' && v.has_clip && (b.kind === 'host' || !v.embedding)) {
        const wav = new Uint8Array(await (await voiceStore.clip(v.id)).arrayBuffer());
        const s = await registerSpeaker(b, `stage:${v.name}`, { wav });
        const mode: SpeakerMode = v.speaker_mode && s.speaker_modes.includes(v.speaker_mode) ? v.speaker_mode : 'embedding';
        return { id: s.id, mode };
      }
      if (!v.embedding) throw new Error('저장한 목소리에 임베딩이 없음');
      const s = await registerSpeaker(b, `stage:${v.name}`, { embedding: v.embedding });
      return { id: s.id, mode: 'embedding' as const };
    })();
    p.catch(() => registered.delete(key));
    registered.set(key, p);
  }
  const { id, mode } = await p;
  return { speaker_embedding_id: id, speaker_mode: mode };
}

/** 조절값 → 생성 요청 필드 */
export function tuningFields(t: VoiceTuning): Record<string, unknown> {
  const out: Record<string, unknown> = { language: t.language || 'ko' };
  const cv = Object.fromEntries(Object.entries(t.condition_values ?? {}).filter(([, x]) => typeof x === 'number'));
  if (Object.keys(cv).length) out.condition_values = cv;
  const ctl = Object.fromEntries(Object.entries(t.controls ?? {}).filter(([, x]) => typeof x === 'number' && x !== 0));
  if (Object.keys(ctl).length) out.controls = ctl;
  const p = t.params ?? {};
  if (typeof p.temperature === 'number') out.temperature = p.temperature;
  if (typeof p.seed === 'number') out.seed = p.seed;
  if (typeof p.speaker_cfg_scale === 'number' && p.speaker_cfg_scale !== 1) out.speaker_cfg_scale = p.speaker_cfg_scale;
  return out;
}

/** 기본 목소리 이름(Minjun ko M 1, Seoyeon ko F 1, AmericanFemale …) → 보기 좋은 이름·언어 */
export function voiceInfo(label: string): { name: string; lang: string | null; tag: string; gender: string } {
  const m = label.match(/^(\S+) ([a-z]{2})(?: (\S+))? ([MF]) \d+$/i);
  if (!m) return { name: label, lang: null, tag: '', gender: '' };
  return { name: m[1], lang: m[2].toLowerCase(), tag: m[3] ?? '', gender: m[4].toUpperCase() };
}

/** 목소리 이름의 언어 → language 필드 */
export function guessLanguage(label: string): string {
  const { lang, tag } = voiceInfo(label);
  if (/british/i.test(label) || /british/i.test(tag)) return 'en_gb';
  return (
    ({ en: 'en_us', ko: 'ko', ja: 'ja', zh: 'cmn', fr: 'fr_fr', de: 'de', es: 'es', it: 'it', pt: 'pt_br', hi: 'hi', te: 'te' } as Record<string, string>)[
      lang ?? ''
    ] ?? 'en_us'
  );
}

export const LANGS: [string, string][] = [
  ['ko', '한국어'],
  ['en_us', 'English (US)'],
  ['en_gb', 'English (UK)'],
  ['ja', '日本語'],
  ['cmn', '中文'],
  ['fr_fr', 'Français'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
  ['it', 'Italiano'],
  ['pt_br', 'Português (BR)'],
];
