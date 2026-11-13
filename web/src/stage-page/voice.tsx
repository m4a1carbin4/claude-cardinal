import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type AsrSettings,
  type AsrStatus,
  type Recording,
  loadAsrSettings,
  micSupported,
  preloadAsr,
  saveAsrSettings,
  startRecording,
  subscribeAsr,
  transcribe,
} from '../asr/client';
import { VoiceListener, listenSupported } from '../asr/listen';
import { AsrOptions } from '../components/MicInput';
import { stripWake } from './wake';

// 스테이지 음성 입력. 글자로 바꾸는 건 대화 탭과 같은 브라우저 안 Whisper (설정 공유), 받는 방식만 셋:
//  버튼      누르면 녹음 시작, 다시 누르면 끝 (대화 탭 MicInput 과 같음, "인식되면 바로 보내기" 따름)
//  누르는 동안  버튼이나 Space 를 누르고 있는 동안만 들음, 떼면 바로 보냄
//  계속 듣기   켜 두면 말할 때마다 알아서 끊어서 보냄 (말 끝은 멈춘 길이로 판단).
//            호출어를 켜면 이름("아로나, …")으로 시작하는 말만 보냄 (ming-voice 의 wake word 처럼)
type Mode = 'click' | 'ptt' | 'vad';

interface VoiceSettings {
  mode: Mode;
  endMs: number;
  sensitivity: number;
  wake: boolean; // 계속 듣기: 이름을 부를 때만 보냄
  wakeWord: string;
  followS: number; // 답이 끝나고 이만큼은 이름 없이 받음
}

const KEY = 'cardinal.stage.voice';
const DEFAULTS: VoiceSettings = { mode: 'click', endMs: 800, sensitivity: 0.5, wake: false, wakeWord: '아로나', followS: 8 };
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'click', label: '버튼', hint: '🎤 를 누르면 녹음, 다시 누르면 끝' },
  { id: 'ptt', label: '누르는 동안', hint: '🎤 나 Space 를 누르고 있는 동안만 듣고, 떼면 바로 보냄' },
  { id: 'vad', label: '계속 듣기', hint: '켜 두면 말할 때마다 끊어서 바로 보냄 (M 으로 켜고 끄기). 마이크는 켜져 있는 동안 계속 열려 있음' },
];
const PTT_IDLE_CLOSE_MS = 60_000; // 누르는 동안: 이만큼 안 쓰면 마이크를 닫음 (다음에 누를 때 다시 엶)

// 계속 듣기에서 소음·숨소리를 Whisper 가 지어내는 흔한 문장 (그대로 이것만 나오면 버림)
const PHANTOM =
  /^(감사합니다|고맙습니다|시청해 ?주셔서 감사합니다|구독과 좋아요.*|MBC 뉴스.*|thank you|thanks for watching|thank you for watching|you|bye)$/i;
const isPhantom = (t: string) => {
  const s = t.replace(/[\s.,!?~…。、]+$/u, '').trim();
  return !s || /^[\p{P}\s]*$/u.test(s) || PHANTOM.test(s);
};

function loadVoice(): VoiceSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

// ---- 호출어 없이 받는 때 ----
// 이름만 부른 직후, 스테이지에서 보낸 말을 관리자가 처리하는 동안(setReplying), 답이 끝나고 followS 초
const wakeState = { until: 0, replying: false, followMs: DEFAULTS.followS * 1000, subs: new Set<() => void>() };
const notifyWake = () => wakeState.subs.forEach((f) => f());
const isAwake = () => wakeState.replying || Date.now() < wakeState.until;
function wakeFor(ms: number) {
  wakeState.until = Math.max(wakeState.until, Date.now() + ms);
  notifyWake();
}

// main.ts 가 부름: 스테이지에서 보낸 턴이 도는 동안 true, 끝나면 false
export function setReplying(on: boolean) {
  const was = wakeState.replying;
  wakeState.replying = on;
  if (was && !on) wakeFor(wakeState.followMs);
  else notifyWake();
}

const typingIn = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

export function StageVoice({
  onText,
  onWake,
  onListen,
}: {
  onText: (text: string, send: boolean) => void;
  onWake?: () => void;
  onListen?: () => void;
}) {
  const [asrSettings, setAsrSettings] = useState<AsrSettings>(loadAsrSettings);
  const [vs, setVs] = useState<VoiceSettings>(loadVoice);
  const [asr, setAsr] = useState<AsrStatus>({});
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [recording, setRecording] = useState(false); // 버튼 녹음 중 / 누르는 동안 누르고 있음
  const [seconds, setSeconds] = useState(0);
  const [listening, setListening] = useState(false); // 계속 듣기 켜짐
  const [speaking, setSpeaking] = useState(false); // 계속 듣기: 지금 말소리가 들림
  const [pending, setPending] = useState(0); // 글자로 바꾸는 중인 마디 수
  const [awake, setAwake] = useState(isAwake); // 호출어 없이 받는 중
  const startedAwake = useRef(false); // 지금 마디를 시작할 때 깨어 있었는지 (인식이 늦게 끝나도 그때 기준)
  const btn = useRef<HTMLButtonElement>(null);
  const rec = useRef<Recording | null>(null);
  const listener = useRef<VoiceListener | null>(null);
  const opening = useRef<Promise<VoiceListener> | null>(null);
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 콜백 안에서 최신 값 쓰기용
  const live = useRef({ asrSettings, vs, onText, onWake, onListen });
  live.current = { asrSettings, vs, onText, onWake, onListen };

  useEffect(() => subscribeAsr(setAsr), []);

  // 깨어 있는 시간이 끝나면 화면도 바꿈
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(t);
      setAwake(isAwake());
      if (!wakeState.replying && wakeState.until > Date.now()) t = setTimeout(check, wakeState.until - Date.now() + 50);
    };
    wakeState.subs.add(check);
    check();
    return () => {
      wakeState.subs.delete(check);
      clearTimeout(t);
    };
  }, []);
  useEffect(() => {
    wakeState.followMs = vs.followS * 1000;
  }, [vs.followS]);

  const updateAsr = (patch: Partial<AsrSettings>) => {
    const next = { ...asrSettings, ...patch };
    setAsrSettings(next);
    saveAsrSettings(next);
  };
  const updateVoice = (patch: Partial<VoiceSettings>) => {
    const next = { ...vs, ...patch };
    setVs(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // 저장 안 돼도 이번엔 씀
    }
  };

  const level = (v: number) => btn.current?.style.setProperty('--lv', v.toFixed(3));

  // 한 마디를 글자로 → onText. send=false 면 입력창에 붙임. vad: 계속 듣기에서 온 마디 (소음 문장 거르기, 호출어)
  const run = useCallback(async (audio: Float32Array, send: boolean, vad?: { awake: boolean }) => {
    if (audio.length < 16_000 * 0.3) {
      setNote('너무 짧음');
      return;
    }
    const secs = audio.length / 16_000; // transcribe 가 버퍼를 워커로 넘겨서 먼저 잼
    const { model, language } = live.current.asrSettings;
    setPending((n) => n + 1);
    try {
      const { text: heard, ms } = await transcribe(audio, model, language);
      let text = heard;
      if (!text || (vad && isPhantom(text))) {
        setNote(text ? `소음으로 보고 버림: “${text}”` : '인식된 말 없음');
        return;
      }
      const { wake, wakeWord } = live.current.vs;
      if (vad && wake) {
        // 깨어 있을 땐 이름이 없어도 받고, 있으면 떼고 보냄
        const rest = stripWake(text, wakeWord);
        if (rest === null && !(vad.awake || isAwake())) {
          setNote(`이름을 안 불러서 안 보냄: “${text}”`);
          return;
        }
        if (rest === '') {
          // 이름만 부름: 대답하고 이어서 하는 말은 이름 없이 받음
          wakeFor(wakeState.followMs);
          setNote('불렀음 · 이어서 말하세요');
          live.current.onWake?.();
          return;
        }
        if (rest !== null) text = rest;
      }
      setNote(`${secs.toFixed(1)}초 → ${(ms / 1000).toFixed(1)}초에 인식`);
      live.current.onText(text, send);
      if (vad && wake) wakeFor(wakeState.followMs); // 답이 오기 전까지 이어서 말해도 받게
    } catch (e) {
      setNote(`인식 실패: ${(e as Error).message}`);
    } finally {
      setPending((n) => n - 1);
    }
  }, []);

  const closeListener = useCallback(() => {
    clearTimeout(idle.current);
    listener.current?.close();
    listener.current = null;
    opening.current = null;
    held.current = false;
    level(0);
    setListening(false);
    setSpeaking(false);
    setRecording(false);
  }, []);

  const ensureListener = useCallback(async () => {
    if (listener.current) return listener.current;
    opening.current ??= VoiceListener.open({
      onLevel: level,
      onSpeech: (on) => {
        if (on) startedAwake.current = isAwake();
        // 호출어 대기 중엔 이름을 부를 때까지 안 끊음 (아무 소리에나 캐릭터가 멈추지 않게)
        if (on && (!live.current.vs.wake || isAwake())) live.current.onListen?.();
        setSpeaking(on);
      },
      onUtterance: (audio) => void run(audio, true, { awake: startedAwake.current }),
    });
    try {
      const l = await opening.current;
      if (!opening.current) {
        l.close(); // 여는 동안 꺼짐
        throw new Error('취소됨');
      }
      listener.current = l;
      return l;
    } catch (e) {
      opening.current = null;
      throw e;
    }
  }, [run]);

  // ---- 버튼 (대화 탭과 같은 녹음) ----
  async function clickToggle() {
    if (rec.current) {
      clearInterval(timer.current);
      const r = rec.current;
      rec.current = null;
      setRecording(false);
      try {
        await run(await r.stop(), live.current.asrSettings.autoSend);
      } catch (e) {
        setNote(`녹음 실패: ${(e as Error).message}`);
      }
      return;
    }
    setNote('');
    try {
      rec.current = await startRecording();
    } catch (e) {
      setNote(`마이크를 못 엶: ${(e as Error).message}`);
      return;
    }
    preloadAsr(asrSettings.model);
    live.current.onListen?.();
    setRecording(true);
    setSeconds(0);
    const t0 = Date.now();
    timer.current = setInterval(() => setSeconds(Math.floor((Date.now() - t0) / 1000)), 250);
  }

  // ---- 누르는 동안 ----
  const pttDown = useCallback(async () => {
    if (held.current) return;
    held.current = true;
    clearTimeout(idle.current);
    setNote('');
    live.current.onListen?.();
    setRecording(true);
    preloadAsr(live.current.asrSettings.model);
    try {
      const l = await ensureListener();
      if (held.current) l.begin(); // 마이크 여는 사이에 뗐으면 시작 안 함
    } catch (e) {
      held.current = false;
      setRecording(false);
      setNote(`마이크를 못 엶: ${(e as Error).message}`);
    }
  }, [ensureListener]);

  const pttUp = useCallback(() => {
    if (!held.current) return;
    held.current = false;
    setRecording(false);
    const l = listener.current;
    if (l?.recording) void run(l.end(), true);
    clearTimeout(idle.current);
    idle.current = setTimeout(closeListener, PTT_IDLE_CLOSE_MS);
  }, [run, closeListener]);

  // ---- 계속 듣기 ----
  const toggleListen = useCallback(async () => {
    if (listener.current?.vad || opening.current) {
      closeListener();
      setNote('계속 듣기 끔');
      return;
    }
    setNote('');
    preloadAsr(live.current.asrSettings.model);
    try {
      const l = await ensureListener();
      const { endMs, sensitivity } = live.current.vs;
      l.vad = { endMs, sensitivity };
      setListening(true);
    } catch (e) {
      setNote(`마이크를 못 엶: ${(e as Error).message}`);
    }
  }, [ensureListener, closeListener]);

  // 말 끝·민감도를 바꾸면 듣는 중에도 바로 반영
  useEffect(() => {
    if (listener.current?.vad) listener.current.vad = { endMs: vs.endMs, sensitivity: vs.sensitivity };
  }, [vs.endMs, vs.sensitivity]);

  // 방식을 바꾸면 하던 것 정리
  useEffect(() => {
    closeListener();
    if (rec.current) {
      clearInterval(timer.current);
      rec.current.cancel();
      rec.current = null;
    }
  }, [vs.mode, closeListener]);

  useEffect(
    () => () => {
      clearInterval(timer.current);
      rec.current?.cancel();
      closeListener();
    },
    [closeListener],
  );

  // 키: 누르는 동안 = Space, 계속 듣기 = M (입력창에 쓰는 중엔 안 받음)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typingIn(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (vs.mode === 'ptt' && e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) void pttDown();
      } else if (vs.mode === 'vad' && e.key.toLowerCase() === 'm' && !e.repeat) void toggleListen();
    };
    const up = (e: KeyboardEvent) => {
      if (vs.mode === 'ptt' && e.code === 'Space') pttUp();
    };
    // 창을 벗어나면 뗀 것으로
    const blur = () => pttUp();
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('keydown', down);
      document.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [vs.mode, pttDown, pttUp, toggleListen]);

  const supported = vs.mode === 'click' ? micSupported() : listenSupported();
  const loading = asr.loading?.model === asrSettings.model ? asr.loading : undefined;
  const label =
    vs.mode === 'click'
      ? recording
        ? `■ ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
        : '🎤'
      : vs.mode === 'ptt'
        ? recording
          ? '● 듣는 중'
          : '🎤 누르고 말하기'
        : !listening
          ? '🎧 계속 듣기'
          : speaking
            ? '● 말하는 중'
            : vs.wake && !awake
              ? `💤 “${vs.wakeWord}” 대기`
              : '🎧 듣는 중';
  const state = recording || speaking ? 'recording' : listening ? 'listening' : '';
  const status =
    pending > 0 ? (loading ? `모델 받는 중 ${Math.round(loading.progress)}%` : `글자로 바꾸는 중${pending > 1 ? ` (${pending})` : ''}…`) : note || asr.error;

  return (
    <div className="mic">
      {/* 설정·안내는 입력줄 위로 떠서 쌓임 */}
      <div className="mic-pop">
        {open && (
          <div className="mic-settings">
            <div className="voice-modes" role="radiogroup" aria-label="듣는 방식">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={vs.mode === m.id}
                  className={vs.mode === m.id ? 'on' : ''}
                  onClick={() => updateVoice({ mode: m.id })}
                  title={m.hint}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="small muted">{MODES.find((m) => m.id === vs.mode)?.hint}</div>
            {vs.mode === 'vad' && (
              <>
                <label title="이만큼 조용하면 한 마디가 끝난 걸로 봄. 짧게 하면 빨리 보내지만 말하다 멈추면 잘림 (1초 안 되는 짧은 말은 0.25초 더 기다림)">
                  말 끝 {(vs.endMs / 1000).toFixed(1)}초
                  <input type="range" min={400} max={2000} step={100} value={vs.endMs} onChange={(e) => updateVoice({ endMs: Number(e.target.value) })} />
                </label>
                <label title="높이면 작은 목소리도 잡지만 주변 소리도 말로 봄">
                  민감도 {Math.round(vs.sensitivity * 100)}
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={vs.sensitivity}
                    onChange={(e) => updateVoice({ sensitivity: Number(e.target.value) })}
                  />
                </label>
              <label className="check" title="켜면 이름으로 시작하는 말만 보냄 (“아로나, 오늘 날씨 어때?”). 이름만 부르면 대답하고, 이어서 하는 말은 이름 없이 받음">
                <input type="checkbox" checked={vs.wake} onChange={(e) => updateVoice({ wake: e.target.checked })} /> 이름을 부를 때만 보내기 (호출어)
              </label>
              {vs.wake && (
                <>
                  <label>
                    이름
                    <input
                      className="wake-word"
                      value={vs.wakeWord}
                      onChange={(e) => updateVoice({ wakeWord: e.target.value })}
                      onBlur={(e) => !e.target.value.trim() && updateVoice({ wakeWord: DEFAULTS.wakeWord })}
                    />
                  </label>
                  <label title="스테이지에서 보낸 말의 답이 끝나고 이만큼은 이름 없이 이어서 말해도 받음 (답을 기다리는 동안도)">
                    답 뒤 이름 없이 {vs.followS}초
                    <input type="range" min={0} max={30} step={1} value={vs.followS} onChange={(e) => updateVoice({ followS: Number(e.target.value) })} />
                  </label>
                </>
              )}
              </>
            )}
            <AsrOptions
              settings={asrSettings}
              update={updateAsr}
              asr={asr}
              busy={recording || listening || pending > 0}
              autoSendLabel="버튼: 인식되면 바로 보내기 (누르는 동안·계속 듣기는 늘 바로 보냄)"
            />
          </div>
        )}
        {status && <div className={`small ${asr.error && !note && !pending ? 'err-text' : 'muted'}`}>{status}</div>}
      </div>
      <div className="row">
        <button
          ref={btn}
          type="button"
          className={`mic-btn ${state} ${vs.mode}`}
          disabled={!supported}
          title={
            !supported
              ? '마이크는 https 또는 localhost/127.0.0.1 주소에서만 쓸 수 있음'
              : MODES.find((m) => m.id === vs.mode)?.hint
          }
          onClick={() => (vs.mode === 'click' ? void clickToggle() : vs.mode === 'vad' ? void toggleListen() : undefined)}
          onPointerDown={(e) => {
            if (vs.mode !== 'ptt') return;
            e.preventDefault();
            // 누른 채 버튼 밖으로 나가도 뗄 때까지 듣게
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // 못 잡으면 버튼 위에서 뗄 때만 끝남
            }
            void pttDown();
          }}
          onPointerUp={() => vs.mode === 'ptt' && pttUp()}
          onPointerCancel={() => vs.mode === 'ptt' && pttUp()}
        >
          {label}
        </button>
        <button type="button" className={`ghost small ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="음성 입력 설정">
          ⚙
        </button>
      </div>
    </div>
  );
}
