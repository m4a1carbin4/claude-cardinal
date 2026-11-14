// 스테이지 왼쪽 패널의 "목소리" 칸: 엔진 고르기(자동·기기·호스트·끔), 지금 엔진·속도, 캐릭터 목소리, 목소리 디자인 열기
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PcmInput } from './player';
import { Designer } from './designer';
import { FALLBACK_VOICE, type TtsManager, type TtsMode, type TtsState } from './manager';
import './tts.css';

const MODES: { id: TtsMode; label: string; hint: string }[] = [
  { id: 'auto', label: '자동', hint: 'WebGPU 가 되고 시험 생성이 충분히 빠르면 기기, 아니면 호스트' },
  { id: 'device', label: '기기', hint: '이 브라우저의 GPU 로 생성 (처음엔 모델 ~1GB 받음)' },
  { id: 'host', label: '호스트', hint: '카디널 서버 컴퓨터의 zonos3-server(CPU) 로 생성' },
  { id: 'off', label: '끔', hint: '말풍선만' },
];

const ms = (v: number) => (v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`);

export function useTts(tts: TtsManager): TtsState {
  const [s, setS] = useState(tts.state);
  useEffect(() => tts.subscribe(setS), [tts]);
  return s;
}

function TtsPanel({ tts, onTest }: { tts: TtsManager; onTest: (text: string, audio: PcmInput) => void }) {
  const s = useTts(tts);
  const [open, setOpen] = useState(false);
  const [designer, setDesigner] = useState(false);
  const voiceName = s.voice?.name ?? FALLBACK_VOICE.name;
  const dot = s.active ? 'ok' : s.mode === 'off' ? '' : s.device.state === 'loading' ? 'busy' : 'warn';
  const engine = s.active === 'device' ? '기기' : s.active === 'host' ? '호스트' : s.mode === 'off' ? '끔' : '못 씀';

  return (
    <div className="tts">
      <button type="button" className="tts-head" onClick={() => setOpen(!open)} title={s.why}>
        <span className={`dot ${dot}`} />
        <span>🔊 {engine}</span>
        <span className="tts-voice">{s.mode !== 'off' && voiceName}</span>
        {s.last && s.mode !== 'off' && (
          <span className="tts-stat" title="첫 소리까지 (TTFA) · 생성 시간 / 소리 길이 (RTF, 1 보다 작아야 실시간)">
            {ms(s.last.ttfa)} · RTF {s.last.rtf?.toFixed(2) ?? '–'}
          </span>
        )}
        <span className="st-spacer" />
        <span className="tts-caret">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="tts-body">
          <div className="voice-modes" role="radiogroup" aria-label="음성 엔진">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={s.mode === m.id}
                className={s.mode === m.id ? 'on' : ''}
                title={m.hint}
                onClick={() => tts.setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="small muted">{s.why}</div>
          <div className="small muted">
            기기: {s.device.state === 'idle' ? '안 불러옴' : s.device.note || s.device.state}
            {s.device.state === 'loading' && <progress max={100} value={s.device.progress} />}
            <br />
            호스트: {{ unknown: '확인 중', ok: '켜짐', down: '답 없음', off: '꺼짐' }[s.host]}
          </div>
          {s.last && (
            <div className="small muted">
              마지막 ({s.last.backend === 'device' ? '기기' : '호스트'}): 첫 소리 {ms(s.last.ttfa)} · 생성 {ms(s.last.genMs)} · 소리 {s.last.audioSec.toFixed(1)}초 · RTF{' '}
              {s.last.rtf?.toFixed(2) ?? '–'}
            </div>
          )}
          {s.queue > 0 && <div className="small muted">생성 대기 {s.queue}줄</div>}
          {s.error && <div className="small err-text">{s.error}</div>}
          <label className="tts-row">
            캐릭터 목소리
            <select value={s.voice?.id ?? ''} onChange={(e) => void tts.setVoice(e.target.value || null)}>
              <option value="">{FALLBACK_VOICE.name}</option>
              {s.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="tts-design-btn" onClick={() => setDesigner(true)}>
            🎛 목소리 디자인…
          </button>
        </div>
      )}
      {designer && <Designer tts={tts} onClose={() => setDesigner(false)} onTest={onTest} />}
    </div>
  );
}

/** onTest: 디자인 창의 "들어보기"를 캐릭터가 말하게 (입 모양까지) */
export function mountTts(host: HTMLElement, tts: TtsManager, onTest: (text: string, audio: PcmInput) => void) {
  createRoot(host).render(<TtsPanel tts={tts} onTest={onTest} />);
}
