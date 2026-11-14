import { useEffect, useRef, useState } from 'react';
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
import { ASR_LANGUAGES, ASR_MODELS, type AsrDevice, modelOf } from '../asr/models';

const MAX_RECORD_S = 300; // 5분 넘으면 알아서 멈춤
const DEVICE_LABEL: Record<AsrDevice, string> = { 'webgpu-f16': 'WebGPU (f16)', webgpu: 'WebGPU', wasm: 'WASM (CPU, 느림)' };

type Phase = 'idle' | 'recording' | 'transcribing';

// 마이크로 말하면 브라우저 안 Whisper 가 글자로 바꿔서 onText 로 넘김 (서버로는 글자만 감)
export function MicInput({ onText, disabled }: { onText: (text: string, autoSend: boolean) => void; disabled?: boolean }) {
  const [settings, setSettings] = useState<AsrSettings>(loadAsrSettings);
  const [asr, setAsr] = useState<AsrStatus>({});
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const rec = useRef<Recording | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const supported = micSupported();

  useEffect(() => subscribeAsr(setAsr), []);
  useEffect(
    () => () => {
      clearInterval(timer.current);
      rec.current?.cancel();
    },
    [],
  );

  const update = (patch: Partial<AsrSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveAsrSettings(next);
  };

  async function start() {
    setNote('');
    try {
      rec.current = await startRecording();
    } catch (e) {
      setNote(`마이크를 못 엶: ${(e as Error).message}`);
      return;
    }
    // 녹음하는 동안 모델을 받아 둠 (처음 한 번만 오래 걸림)
    preloadAsr(settings.model);
    setPhase('recording');
    setSeconds(0);
    const t0 = Date.now();
    timer.current = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setSeconds(s);
      if (s >= MAX_RECORD_S) void stop();
    }, 250);
  }

  async function stop() {
    clearInterval(timer.current);
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    setPhase('transcribing');
    try {
      const audio = await r.stop();
      if (audio.length < 16_000 * 0.3) {
        setNote('너무 짧음');
        return;
      }
      // 길이는 먼저 재 둠 (transcribe 가 버퍼를 워커로 넘겨서 그 뒤엔 0)
      const secs = audio.length / 16_000;
      const { text, ms } = await transcribe(audio, settings.model, settings.language);
      if (!text) setNote('인식된 말 없음');
      else {
        setNote(`${secs.toFixed(1)}초 → ${(ms / 1000).toFixed(1)}초에 인식`);
        onText(text, settings.autoSend);
      }
    } catch (e) {
      setNote(`인식 실패: ${(e as Error).message}`);
    } finally {
      setPhase('idle');
    }
  }

  function cancel() {
    clearInterval(timer.current);
    rec.current?.cancel();
    rec.current = null;
    setPhase('idle');
    setNote('취소함');
  }

  const loading = asr.loading?.model === settings.model ? asr.loading : undefined;
  const label =
    phase === 'recording'
      ? `■ ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
      : phase === 'transcribing'
        ? loading
          ? `모델 ${Math.round(loading.progress)}%`
          : '인식 중…'
        : '🎤';

  return (
    <div className="mic">
      <div className="row">
        <button
          type="button"
          className={`mic-btn ${phase}`}
          onClick={() => (phase === 'recording' ? stop() : phase === 'idle' ? start() : undefined)}
          disabled={!supported || disabled || phase === 'transcribing'}
          title={
            !supported
              ? '마이크는 https 또는 localhost/127.0.0.1 주소에서만 쓸 수 있음'
              : phase === 'recording'
                ? '멈추고 글자로 바꾸기'
                : '말해서 입력 (브라우저 안 Whisper, 음성은 서버로 안 감)'
          }
        >
          {label}
        </button>
        {phase === 'recording' && (
          <button type="button" className="ghost small" onClick={cancel}>
            취소
          </button>
        )}
        <button type="button" className={`ghost small ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="음성 입력 설정">
          ⚙
        </button>
      </div>
      {open && (
        <div className="mic-settings">
          <AsrOptions settings={settings} update={update} asr={asr} busy={phase !== 'idle'} />
        </div>
      )}
      {phase === 'recording' && loading ? (
        <div className="small muted">
          듣는 중… 그동안 모델 받는 중 {Math.round(loading.progress)}% ({(loading.loaded / 1e6).toFixed(0)}/{(loading.total / 1e6).toFixed(0)}MB)
        </div>
      ) : (
        (note || asr.error) && <div className={`small ${asr.error && !note ? 'err-text' : 'muted'}`}>{note || asr.error}</div>
      )}
    </div>
  );
}

// 모델·언어·바로 보내기 + 장치/받을 크기/미리 받기. 대화 탭 MicInput 과 스테이지 음성 입력이 같이 씀 (설정도 같음)
export function AsrOptions({
  settings,
  update,
  asr,
  busy,
  autoSendLabel = '인식되면 바로 보내기',
}: {
  settings: AsrSettings;
  update: (patch: Partial<AsrSettings>) => void;
  asr: AsrStatus;
  busy: boolean; // 녹음·인식 중엔 모델을 못 바꿈
  autoSendLabel?: string;
}) {
  const loading = asr.loading?.model === settings.model ? asr.loading : undefined;
  const m = modelOf(settings.model);
  // CPU 로만이면 WASM 모델 (장치 확인 결과와 상관없이)
  const device = settings.cpuOnly ? 'wasm' : asr.device;
  const size = device ? m.size[device] : m.size['webgpu-f16'];
  const ready = asr.ready === settings.model && asr.cpu === settings.cpuOnly;
  return (
    <>
      <label>
        모델
        <select value={settings.model} onChange={(e) => update({ model: e.target.value as AsrSettings['model'] })} disabled={busy}>
          {ASR_MODELS.map((x) => (
            <option key={x.key} value={x.key}>
              {x.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        언어
        <select value={settings.language} onChange={(e) => update({ language: e.target.value })}>
          {ASR_LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.autoSend} onChange={(e) => update({ autoSend: e.target.checked })} /> {autoSendLabel}
      </label>
      <label className="check" title="GPU 가 다른 일(이미지 생성 등)로 꽉 차 있을 때. 느리지만 GPU 메모리를 안 씀">
        <input
          type="checkbox"
          checked={settings.cpuOnly}
          disabled={busy}
          onChange={(e) => {
            const cpuOnly = e.target.checked;
            update({ cpuOnly });
            // 이미 불러온 모델이 있으면 바로 새 방식으로 다시 불러옴 (이전 것은 워커가 버림)
            if (asr.ready || asr.loading) preloadAsr(settings.model, cpuOnly);
          }}
        />{' '}
        CPU 로만 (WebGPU 안 씀)
      </label>
      <div className="row wrap small muted">
        <span>
          {device ? DEVICE_LABEL[device] : '장치 확인 전'} · 받을 크기 약 {size}MB (처음 한 번, 브라우저에 저장)
        </span>
        {ready ? (
          <span className="badge ok">준비됨</span>
        ) : loading ? (
          <span className="badge info">받는 중 {Math.round(loading.progress)}%</span>
        ) : (
          <button type="button" className="ghost small" onClick={() => preloadAsr(settings.model, settings.cpuOnly)}>
            미리 받기
          </button>
        )}
      </div>
    </>
  );
}
