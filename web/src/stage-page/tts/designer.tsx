// 목소리 디자인 창: 기본 목소리 고르기(미리 듣기) / 두 목소리 섞기(slerp) / 내 음성 올리기·녹음(모노 44.1kHz, 30초까지)
// + 조절값(말 빠르기·크기·샘플링·스티어링) + 시험 대사 → "저장"하면 카디널 서버 목소리 저장소에 (두 엔진 다 씀)
import { useEffect, useMemo, useRef, useState } from 'react';
import { decodeToMono, getJson, slerp, wavBytes, SR, type Backend } from './backend';
import type { TtsManager } from './manager';
import { useTts } from './panel';
import type { PcmInput } from './player';
import {
  engineSpeakers,
  guessLanguage,
  LANGS,
  registerSpeaker,
  speakerEmbedding,
  tuningFields,
  voiceInfo,
  voiceStore,
  type EngineSpeaker,
  type SavedVoice,
  type SpeakerMode,
  type VoiceTuning,
} from './voices';

type SourceKind = 'default' | 'blend' | 'clip';

interface Caps {
  condition_tokens?: { names: string[]; edges: Record<string, number[]> } | null;
}
interface ControlsDoc {
  sets: Record<string, { calibration?: { default?: Record<string, number>; global_default?: number } }>;
  directions: Record<string, { set: string }>;
}

const MAX_CLIP_S = 30;
const DEFAULT_TEST = '안녕하세요, 선생님! 오늘은 어떤 일을 도와드릴까요?';

const engineLabel = (b: Backend | null) => (b?.kind === 'device' ? '기기' : b?.kind === 'host' ? '호스트' : '없음');

export function Designer({ tts, onClose, onTest }: { tts: TtsManager; onClose: () => void; onTest: (text: string, audio: PcmInput) => void }) {
  const st = useTts(tts);
  const b = tts.backend();
  const [speakers, setSpeakers] = useState<EngineSpeaker[]>([]);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [controls, setControls] = useState<ControlsDoc | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // 지금 만드는 목소리
  const [editId, setEditId] = useState<string | undefined>();
  const [name, setName] = useState('');
  const [source, setSource] = useState<SourceKind>('default');
  const [pick, setPick] = useState<string | null>(null); // 기본 목소리 id
  const [blendA, setBlendA] = useState<string | null>(null);
  const [blendB, setBlendB] = useState<string | null>(null);
  const [blendT, setBlendT] = useState(0.5);
  const [clip, setClip] = useState<Float32Array | null>(null);
  const [clipNote, setClipNote] = useState('');
  const clipSpeaker = useRef<{ backend: string; clip: Float32Array; id: string; modes: string[] } | null>(null);
  const [tuning, setTuning] = useState<VoiceTuning>({ language: 'ko', speaker_mode: 'reference' });
  const [testText, setTestText] = useState(DEFAULT_TEST);
  const [makeActive, setMakeActive] = useState(true);
  const [stats, setStats] = useState('');
  const [recording, setRecording] = useState<{ stop: () => void; secs: number } | null>(null);
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);

  const defaults = useMemo(
    () => speakers.filter((s) => s.is_default).sort((x, y) => x.label.localeCompare(y.label)),
    [speakers],
  );
  const byId = (id: string | null) => speakers.find((s) => s.id === id);

  useEffect(() => {
    if (!b) return;
    let gone = false;
    engineSpeakers(b, true).then((l) => !gone && setSpeakers(l), (e) => setMsg(`목소리 목록 실패: ${e.message}`));
    getJson<Caps>(b, '/v2/capabilities').then((c) => !gone && setCaps(c), () => {});
    // 스티어링 번들(steer.gguf)이 없는 엔진은 4xx → 조절 칸을 안 보임
    getJson<ControlsDoc>(b, '/v2/controls').then((c) => !gone && setControls(c?.directions ? c : null), () => setControls(null));
    return () => {
      gone = true;
    };
  }, [b]);

  // 처음 열면 지금 캐릭터 목소리를 불러옴
  useEffect(() => {
    if (speakers.length && !pick && !editId) {
      const v = st.voice;
      if (v) void load(v);
      else {
        const s = defaults.find((x) => x.label === 'Seoyeon ko F 1') ?? defaults[0];
        if (s) setPick(s.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakers]);

  useEffect(() => () => previewAudio.current?.pause(), []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const tune = (patch: Partial<VoiceTuning>) => setTuning((t) => ({ ...t, ...patch }));
  const cond = (k: 'speaking_rate' | 'loudness' | 'fmax', v: number | undefined) =>
    setTuning((t) => ({ ...t, condition_values: { ...t.condition_values, [k]: v } }));
  const param = (patch: NonNullable<VoiceTuning['params']>) => setTuning((t) => ({ ...t, params: { ...t.params, ...patch } }));

  async function load(v: SavedVoice) {
    setEditId(v.id);
    setName(v.name);
    setTuning({ language: v.language, speaker_mode: v.speaker_mode, condition_values: v.condition_values, controls: v.controls, params: v.params });
    if (v.test_text) setTestText(v.test_text);
    const find = (label: string) => speakers.find((s) => s.is_default && s.label === label)?.id ?? null;
    setSource(v.source.type);
    if (v.source.type === 'default') setPick(find(v.source.label));
    if (v.source.type === 'blend') {
      setBlendA(find(v.source.a));
      setBlendB(find(v.source.b));
      setBlendT(v.source.t);
    }
    if (v.source.type === 'clip' && v.has_clip) {
      try {
        setClipFrom(await decodeToMono(await voiceStore.clip(v.id), MAX_CLIP_S), `${v.name} (저장된 참고 음성)`);
      } catch (e) {
        setMsg(`참고 음성을 못 읽음: ${(e as Error).message}`);
      }
    }
  }

  function newVoice() {
    setEditId(undefined);
    setName('');
    setStats('');
  }

  // ---- 미리 듣기 (기본 목소리 원본) ----
  async function preview(s: EngineSpeaker) {
    previewAudio.current?.pause();
    if (previewing === s.id || !b) return setPreviewing(null);
    try {
      const r = await b.fetch(`/v2/speakers/${encodeURIComponent(s.id)}/preview`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const a = new Audio(URL.createObjectURL(await r.blob()));
      previewAudio.current = a;
      a.onended = () => setPreviewing(null);
      setPreviewing(s.id);
      await a.play();
    } catch (e) {
      setMsg(`미리 듣기 실패: ${(e as Error).message}`);
      setPreviewing(null);
    }
  }

  // ---- 내 음성 ----
  function setClipFrom(f32: Float32Array, label: string) {
    let peak = 0;
    for (const v of f32) peak = Math.max(peak, Math.abs(v));
    if (peak > 0 && peak < 0.5) for (let i = 0; i < f32.length; i++) f32[i] *= 0.9 / peak; // 작게 녹음됐으면 키움
    const secs = f32.length / SR;
    setClip(f32);
    clipSpeaker.current = null;
    setClipNote(`${label} → 모노 44.1kHz ${secs.toFixed(1)}초${secs < 4 ? ' (짧음: 5초 이상 권장)' : ''}`);
    if (!name) setName(label.replace(/\.[^.]+$/, '').slice(0, 40));
  }

  async function takeFile(f: File) {
    try {
      setClipFrom(await decodeToMono(f, MAX_CLIP_S), f.name);
      setSource('clip');
    } catch (e) {
      setMsg(`이 파일을 브라우저에서 못 읽음: ${(e as Error).message}`);
    }
  }

  async function record() {
    if (recording) return recording.stop();
    let stream: MediaStream;
    try {
      // 참고 음성은 목소리 그대로가 좋아서 에코 제거·자동 크기는 끔
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false } });
    } catch (e) {
      return setMsg(`마이크를 못 엶 (https·localhost 에서만): ${(e as Error).message}`);
    }
    const parts: Blob[] = [];
    const rec = new MediaRecorder(stream);
    const t0 = Date.now();
    rec.ondataavailable = (e) => parts.push(e.data);
    const timer = setInterval(() => {
      const secs = (Date.now() - t0) / 1000;
      if (secs >= MAX_CLIP_S) rec.stop();
      else setRecording((r) => r && { ...r, secs });
    }, 250);
    rec.onstop = async () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      setRecording(null);
      try {
        setClipFrom(await decodeToMono(new Blob(parts, { type: parts[0]?.type || 'audio/webm' }), MAX_CLIP_S), `녹음 ${new Date().toLocaleTimeString()}`);
      } catch (e) {
        setMsg(`녹음을 못 읽음: ${(e as Error).message}`);
      }
    };
    rec.start();
    setSource('clip');
    setRecording({ stop: () => rec.state !== 'inactive' && rec.stop(), secs: 0 });
  }

  /** 참고 음성 → 지금 엔진의 화자 (한 번 올리면 같은 음성·엔진에선 다시 씀) */
  async function clipSpeakerId(): Promise<{ id: string; modes: string[] }> {
    if (!b || !clip) throw new Error('참고 음성이 없음');
    const c = clipSpeaker.current;
    if (c && c.backend === b.kind && c.clip === clip) return c;
    if (b.kind === 'device' && !tts.deviceFiles?.upload)
      throw new Error('기기 엔진에 음성 → 화자 모델(encoder·teacher)이 없음. 호스트 엔진으로 바꿔서 만드세요 (저장하면 기기에서도 씀)');
    setMsg(b.kind === 'device' ? '음성 → 화자 (기기: 처음엔 모델 ~2.7GB 받음)…' : '음성 → 화자 (호스트 CPU)…');
    const s = await registerSpeaker(b, `stage-draft:${name || 'clip'}`, { wav: wavBytes(clip) });
    clipSpeaker.current = { backend: b.kind, clip, id: s.id, modes: s.speaker_modes };
    setMsg('');
    return clipSpeaker.current;
  }

  /** 지금 만드는 목소리 → 생성 요청 화자 필드 */
  async function draftSpeaker(): Promise<Record<string, unknown>> {
    if (source === 'default') {
      const s = byId(pick);
      if (!s) throw new Error('목소리를 고르세요');
      const mode = tuning.speaker_mode && s.speaker_modes.includes(tuning.speaker_mode) ? tuning.speaker_mode : s.speaker_modes[0];
      return { speaker_embedding_id: s.id, speaker_mode: mode };
    }
    if (source === 'blend') {
      if (!blendA || !blendB) throw new Error('섞을 목소리 둘을 고르세요');
      return { speaker_blend_embedding_id_a: blendA, speaker_blend_embedding_id_b: blendB, speaker_blend_t: blendT, speaker_mode: 'embedding' };
    }
    const c = await clipSpeakerId();
    const mode = tuning.speaker_mode && c.modes.includes(tuning.speaker_mode) ? tuning.speaker_mode : 'embedding';
    return { speaker_embedding_id: c.id, speaker_mode: mode };
  }

  async function test() {
    if (!b) return setMsg('쓸 수 있는 엔진이 없음');
    setBusy(true);
    setStats('생성 중…');
    try {
      const body = { text: testText, ...tuningFields(tuning), ...(await draftSpeaker()) };
      const { input, stats: done } = tts.preview(b, body);
      onTest(testText, input);
      const s = await done;
      setStats(`${engineLabel(b)}: 첫 소리 ${Math.round(s.ttfa)}ms · 생성 ${(s.genMs / 1000).toFixed(2)}초 · 소리 ${s.audioSec.toFixed(1)}초 · RTF ${s.rtf?.toFixed(2) ?? '–'} · seed ${s.seed ?? '?'}`);
    } catch (e) {
      setStats('');
      if ((e as Error).name !== 'AbortError') setMsg(`생성 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!b) return setMsg('쓸 수 있는 엔진이 없음');
    if (!name.trim()) return setMsg('이름을 적으세요');
    setBusy(true);
    setMsg('저장 중…');
    try {
      let src: SavedVoice['source'];
      let embedding: number[];
      if (source === 'default') {
        const s = byId(pick);
        if (!s) throw new Error('목소리를 고르세요');
        src = { type: 'default', label: s.label };
        embedding = await speakerEmbedding(b, s.id);
      } else if (source === 'blend') {
        const a = byId(blendA);
        const c = byId(blendB);
        if (!a || !c) throw new Error('섞을 목소리 둘을 고르세요');
        src = { type: 'blend', a: a.label, b: c.label, t: blendT };
        embedding = slerp(await speakerEmbedding(b, a.id), await speakerEmbedding(b, c.id), blendT);
      } else {
        if (!clip) throw new Error('참고 음성을 올리거나 녹음하세요');
        src = { type: 'clip' };
        embedding = await speakerEmbedding(b, (await clipSpeakerId()).id);
      }
      const speaker_mode: SpeakerMode | undefined = source === 'blend' ? 'embedding' : tuning.speaker_mode;
      const saved = await voiceStore.save(
        { id: editId, name: name.trim(), source: src, ...tuning, speaker_mode, embedding, test_text: testText },
        source === 'clip' && clip ? wavBytes(clip) : undefined,
      );
      setEditId(saved.id);
      if (makeActive) await tts.setVoice(saved.id);
      else await tts.refreshVoices();
      setMsg(`저장함: ${saved.name}${makeActive ? ' (캐릭터 목소리로)' : ''}`);
    } catch (e) {
      setMsg(`저장 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(v: SavedVoice) {
    if (!window.confirm(`“${v.name}” 목소리를 지울까요?`)) return;
    try {
      await voiceStore.remove(v.id);
      if (editId === v.id) newVoice();
      await tts.refreshVoices();
    } catch (e) {
      setMsg(`지우기 실패: ${(e as Error).message}`);
    }
  }

  const clipUrl = useClipUrl(clip);
  const edges = caps?.condition_tokens?.edges ?? {};
  const rateEdges = edges.speaking_rate;
  const loudEdges = edges.loudness;
  const cv = tuning.condition_values ?? {};
  const p = tuning.params ?? {};
  const modes = source === 'default' ? (byId(pick)?.speaker_modes ?? []) : source === 'clip' ? (clipSpeaker.current?.modes ?? ['reference', 'embedding']) : ['embedding'];

  return (
    <div className="tts-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tts-dialog" role="dialog" aria-label="목소리 디자인">
        <div className="tts-dialog-head">
          <b>목소리 디자인</b>
          <span className="small muted">엔진: {engineLabel(b)}</span>
          <span className="st-spacer" />
          <button type="button" className="ghost" onClick={onClose}>
            닫기
          </button>
        </div>
        {!b && <div className="err-text small">쓸 수 있는 엔진이 없음: {st.why}</div>}

        <section>
          <h4>저장한 목소리</h4>
          <div className="tts-saved">
            {st.voices.length === 0 && <div className="small muted">아직 없음. 아래에서 만들고 저장하세요.</div>}
            {st.voices.map((v) => (
              <div key={v.id} className={`tts-saved-row ${editId === v.id ? 'sel' : ''}`}>
                <span className="tts-saved-name">
                  {st.voice?.id === v.id && '★ '}
                  {v.name}
                </span>
                <span className="small muted">{v.source.type === 'default' ? voiceInfo(v.source.label).name : v.source.type === 'blend' ? '섞기' : '참고 음성'}</span>
                <span className="st-spacer" />
                <button type="button" className="ghost small" onClick={() => void tts.setVoice(v.id)} disabled={st.voice?.id === v.id}>
                  캐릭터로
                </button>
                <button type="button" className="ghost small" onClick={() => void load(v)}>
                  고치기
                </button>
                <button type="button" className="ghost small" onClick={() => void remove(v)}>
                  지우기
                </button>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h4>
            목소리 {editId ? '고치기' : '만들기'}
            {editId && (
              <button type="button" className="ghost small" onClick={newVoice}>
                새로 만들기
              </button>
            )}
          </h4>
          <div className="voice-modes" role="radiogroup">
            {(
              [
                ['default', '기본 목소리'],
                ['blend', '섞기'],
                ['clip', '내 음성'],
              ] as [SourceKind, string][]
            ).map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={source === k} className={source === k ? 'on' : ''} onClick={() => setSource(k)}>
                {l}
              </button>
            ))}
          </div>

          {source === 'default' && (
            <div className="tts-grid">
              {defaults.map((s) => {
                const v = voiceInfo(s.label);
                return (
                  <div
                    key={s.id}
                    className={`tts-voice-card ${pick === s.id ? 'sel' : ''}`}
                    onClick={() => {
                      setPick(s.id);
                      tune({ language: guessLanguage(s.label) });
                    }}
                  >
                    <button
                      type="button"
                      className="ghost small"
                      disabled={!s.has_preview}
                      onClick={(e) => {
                        e.stopPropagation();
                        void preview(s);
                      }}
                      title="원본 음성 듣기"
                    >
                      {previewing === s.id ? '■' : '▶'}
                    </button>
                    <span>
                      {v.name}
                      <span className="small muted"> {[v.lang, v.tag, v.gender].filter(Boolean).join(' · ')}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {source === 'blend' && (
            <div className="tts-blend">
              {(
                [
                  ['A', blendA, setBlendA],
                  ['B', blendB, setBlendB],
                ] as const
              ).map(([k, val, setter]) => (
                <label key={k} className="tts-row">
                  {k}
                  <select value={val ?? ''} onChange={(e) => setter(e.target.value || null)}>
                    <option value="">고르기</option>
                    {defaults.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="tts-row">
                A {Math.round((1 - blendT) * 100)}% · B {Math.round(blendT * 100)}%
                <input type="range" min={0} max={1} step={0.05} value={blendT} onChange={(e) => setBlendT(Number(e.target.value))} />
              </label>
              <div className="small muted">화자 임베딩을 구면 보간(slerp)으로 섞음. 임베딩 모드로만 말함</div>
            </div>
          )}

          {source === 'clip' && (
            <div className="tts-clip">
              <div className="tts-row">
                <label className="ghost-btn">
                  파일 올리기
                  <input type="file" accept="audio/*" hidden onChange={(e) => e.target.files?.[0] && void takeFile(e.target.files[0])} />
                </label>
                <button type="button" className={recording ? 'rec' : ''} onClick={() => void record()}>
                  {recording ? `■ 녹음 멈춤 (${Math.floor(recording.secs)}초)` : '● 녹음'}
                </button>
              </div>
              {clipNote && <div className="small muted">{clipNote}</div>}
              {clipUrl && <audio controls src={clipUrl} />}
              <div className="small muted">한 사람이 또렷하게 말하는 5~30초. 브라우저에서 모노 44.1kHz 로 바꿔서 씀</div>
            </div>
          )}
        </section>

        <section className="tts-tune">
          <h4>조절</h4>
          <label className="tts-row">
            언어
            <select value={tuning.language} onChange={(e) => tune({ language: e.target.value })}>
              {LANGS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {modes.length > 1 && (
            <label className="tts-row" title="reference: 참고 음성 앞부분을 이어 말하듯 (닮음↑), embedding: 화자 임베딩만 (안정적, 섞기·스티어링 됨)">
              화자 방식
              <select value={tuning.speaker_mode ?? modes[0]} onChange={(e) => tune({ speaker_mode: e.target.value as SpeakerMode })}>
                {modes.map((m) => (
                  <option key={m} value={m}>
                    {m === 'reference' ? 'reference (참고 음성)' : 'embedding (임베딩)'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {rateEdges && (
            <Slider
              label="말 빠르기"
              unit="바이트/초"
              min={rateEdges[0]}
              max={rateEdges[rateEdges.length - 1]}
              step={0.5}
              value={cv.speaking_rate}
              fallback={14}
              onChange={(v) => cond('speaking_rate', v)}
              hint="UTF-8 바이트/초 (한글 한 글자 = 3바이트). 자동이면 목소리 따라"
            />
          )}
          {loudEdges && (
            <Slider
              label="크기"
              unit="LUFS"
              min={loudEdges[0]}
              max={loudEdges[loudEdges.length - 1]}
              step={0.5}
              value={cv.loudness}
              fallback={-22}
              onChange={(v) => cond('loudness', v)}
            />
          )}
          <Slider
            label="다양함 (temperature)"
            min={0.3}
            max={1.2}
            step={0.05}
            value={p.temperature}
            fallback={0.75}
            onChange={(v) => param({ temperature: v })}
            hint="낮으면 차분·일정, 높으면 표현이 커지지만 불안정"
          />
          <Slider
            label="화자 닮음 (speaker CFG)"
            min={1}
            max={3}
            step={0.1}
            value={p.speaker_cfg_scale}
            fallback={1}
            onChange={(v) => param({ speaker_cfg_scale: v })}
            hint="1 = 끔. 높이면 목소리를 더 닮지만 느려짐 (두 번 계산)"
          />
          <label className="tts-row" title="같은 seed 면 같은 대사가 같게 나옴 (비우면 매번 다름)">
            seed
            <input
              type="number"
              value={p.seed ?? ''}
              placeholder="무작위"
              onChange={(e) => param({ seed: e.target.value === '' ? null : Math.floor(Number(e.target.value)) })}
            />
          </label>
          {controls && (
            <details>
              <summary>스티어링 (감정·스타일)</summary>
              {Object.entries(controls.directions).map(([d, info]) => {
                const key = d.includes('.') ? d : `${info.set}.${d}`;
                const cal = controls.sets[info.set]?.calibration;
                const scale = cal?.default?.[d.split('.').pop()!] ?? cal?.global_default ?? 1;
                return (
                  <Slider
                    key={key}
                    label={key}
                    min={-2 * scale}
                    max={2 * scale}
                    step={scale / 20}
                    value={tuning.controls?.[key]}
                    fallback={0}
                    onChange={(v) => setTuning((t) => ({ ...t, controls: { ...t.controls, [key]: v ?? 0 } }))}
                  />
                );
              })}
            </details>
          )}
          {!controls && <div className="small muted">스티어링(감정 등): 이 엔진엔 스티어링 번들이 없음</div>}
        </section>

        <section>
          <h4>들어보기</h4>
          <textarea rows={2} value={testText} onChange={(e) => setTestText(e.target.value)} />
          <div className="tts-row">
            <button type="button" onClick={() => void test()} disabled={busy || !b || !testText.trim()}>
              ▶ 캐릭터가 말하기
            </button>
            <span className="small muted">{stats}</span>
          </div>
        </section>

        <section className="tts-save">
          <input value={name} placeholder="목소리 이름" maxLength={60} onChange={(e) => setName(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={makeActive} onChange={(e) => setMakeActive(e.target.checked)} /> 캐릭터 목소리로
          </label>
          <button type="button" onClick={() => void save()} disabled={busy || !b}>
            {editId ? '고친 것 저장' : '저장'}
          </button>
        </section>
        {msg && <div className="small muted tts-msg">{msg}</div>}
      </div>
    </div>
  );
}

function useClipUrl(clip: Float32Array | null): string | null {
  const url = useMemo(() => (clip ? URL.createObjectURL(new Blob([wavBytes(clip) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' })) : null), [clip]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return url;
}

function Slider(props: {
  label: string;
  unit?: string;
  min: number;
  max: number;
  step: number;
  value: number | undefined;
  fallback: number;
  onChange: (v: number | undefined) => void;
  hint?: string;
}) {
  const on = props.value !== undefined;
  const v = props.value ?? props.fallback;
  return (
    <div className="tts-slider" title={props.hint}>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => props.onChange(e.target.checked ? v : undefined)} />
        {props.label}
      </label>
      <input type="range" min={props.min} max={props.max} step={props.step} value={v} disabled={!on} onChange={(e) => props.onChange(Number(e.target.value))} />
      <span className="small muted">{on ? `${Number(v.toFixed(2))}${props.unit ? ` ${props.unit}` : ''}` : '자동'}</span>
    </div>
  );
}
