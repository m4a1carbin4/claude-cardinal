import { useState } from 'react';
import { api } from '../api';
import type { CreateInput, Role, RouteInput } from '../types';
import { RouteFields, emptyRoute } from './RouteFields';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

export function CreateSession({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('worker');
  const [cwd, setCwd] = useState('');
  const [trust, setTrust] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [args, setArgs] = useState('');
  const [routes, setRoutes] = useState<RouteInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const nameOk = NAME_RE.test(name);
  const cwdOk = !cwd || cwd.startsWith('/');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!nameOk || !cwdOk) return;
    setBusy(true);
    setError('');
    const body: CreateInput = {
      name,
      role,
      routes,
      cwd: cwd || undefined,
      trust,
      prompt: prompt || undefined,
      args: args.trim() ? args.trim().split(/\s+/) : undefined,
    };
    try {
      await api.create(body);
      onCreated(name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <h2>새 세션</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <div className="grid2">
          <label>
            이름
            <input value={name} autoFocus required onChange={(e) => setName(e.target.value)} placeholder="영문/숫자/-/_, 최대 48자" />
            {name && !nameOk && <span className="hint err">이름 규칙: 영문/숫자로 시작, 영문/숫자/-/_ 만</span>}
          </label>
          <label>
            역할
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="worker">worker — 자기 일만</option>
              <option value="master">master — 워커를 띄워 일을 나눔</option>
            </select>
          </label>
        </div>

        <label>
          작업 폴더 (선택)
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="절대 경로. 비우면 기본 워크스페이스" />
          {!cwdOk && <span className="hint err">절대 경로(/로 시작)여야 함</span>}
        </label>
        <label className="check">
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
          처음 쓰는 폴더면 신뢰 다이얼로그 자동 수락 (--trust)
        </label>

        <label>
          첫 지시 (선택)
          <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="만들자마자 보낼 프롬프트" />
        </label>
        <label>
          claude 추가 인자 (선택)
          <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="예: --model sonnet" />
        </label>

        <div className="section-title">
          채널 라우트 <span className="muted small">— 이 조건에 맞는 채널 메시지를 이 세션에 넘김</span>
        </div>
        {routes.map((r, i) => (
          <div key={i} className="route-box">
            <RouteFields value={r} onChange={(nr) => setRoutes(routes.map((x, j) => (j === i ? nr : x)))} />
            <button type="button" className="ghost small" onClick={() => setRoutes(routes.filter((_, j) => j !== i))}>
              라우트 빼기
            </button>
          </div>
        ))}
        <button type="button" className="ghost" onClick={() => setRoutes([...routes, emptyRoute()])}>
          + 라우트 추가
        </button>

        {error && <div className="alert err">{error}</div>}
        <div className="modal-foot">
          <button type="button" className="ghost" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={busy || !nameOk || !cwdOk}>
            {busy ? '만드는 중…' : '만들기'}
          </button>
        </div>
      </form>
    </div>
  );
}
