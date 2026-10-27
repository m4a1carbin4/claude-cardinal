import { useCallback, useEffect, useState } from 'react';
import { useInterval } from '../hooks';
import { PASTE_MAX_BYTES, api, byteLength } from '../api';
import { clock, unwrapPasted } from '../format';
import type { HookEvent, Report, Route, RouteInput, SendResult } from '../types';
import { RouteFields, emptyRoute } from './RouteFields';

// ---------- 보내기 + 키 ----------

const KEYS: { label: string; keys: string[]; title: string }[] = [
  { label: 'Enter', keys: ['Enter'], title: '입력창 제출 / 다이얼로그 선택' },
  { label: 'Esc', keys: ['Escape'], title: '진행 중인 턴 중단 (사람 개입)' },
  { label: '↑', keys: ['Up'], title: '위' },
  { label: '↓', keys: ['Down'], title: '아래' },
  { label: '신뢰 수락', keys: ['Down', 'Enter'], title: '작업 폴더 신뢰 다이얼로그에서 "Yes"' },
  { label: 'Ctrl+C', keys: ['C-c'], title: '입력 지우기 (빈 입력에서 두 번이면 종료되니 주의)' },
];

// sdk: 입력창이 없어서 키·붙여넣기만·tmux 크기 한도가 없음
export function SendPanel({ name, sdk = false }: { name: string; sdk?: boolean }) {
  const [text, setText] = useState('');
  const [wait, setWait] = useState(true);
  const [timeoutS, setTimeoutS] = useState(900);
  const [submit, setSubmit] = useState(true);
  const [now, setNow] = useState(false);
  const [force, setForce] = useState(false);
  const [customKeys, setCustomKeys] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(SendResult & { pasteOnly?: boolean }) | null>(null);
  const [error, setError] = useState('');
  const bytes = byteLength(text);
  const tooBig = !sdk && bytes > PASTE_MAX_BYTES;

  async function send() {
    if (!text.trim() || tooBig) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      // 붙여넣기만(submit=false)이면 턴이 시작되지 않으니 기다릴 게 없음
      const w = wait && submit;
      const r = await api.send(name, { text, wait: w, submit, now, force, timeout_s: w ? timeoutS : undefined });
      setResult({ ...r, pasteOnly: !submit });
      setText('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function keys(k: string[]) {
    setError('');
    try {
      await api.keys(name, k);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="panel">
      <label>
        메시지
        <textarea
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && send()}
          placeholder="세션에 보낼 지시 (⌘/Ctrl + Enter 로 보내기)"
        />
      </label>
      {!sdk && (
        <div className={`bytes ${tooBig ? 'err' : ''}`}>
          {bytes.toLocaleString()} / {PASTE_MAX_BYTES.toLocaleString()} 바이트
          {tooBig && ' — tmux 한 번 전달 한도 초과. 긴 내용은 파일로 저장하고 경로를 보내세요'}
        </div>
      )}
      <div className="row wrap">
        <label className="check">
          <input type="checkbox" checked={wait && submit} disabled={!submit} onChange={(e) => setWait(e.target.checked)} /> 턴 끝날 때까지 기다리고 응답 받기
        </label>
        {wait && submit && (
          <label className="check" title="이 시간 안에 턴이 안 끝나면 지금까지의 부분 응답을 돌려줌 (실패 아님)">
            최대
            <input className="num" type="number" min={1} max={3600} value={timeoutS} onChange={(e) => setTimeoutS(Math.max(1, Number(e.target.value) || 900))} />
            초
          </label>
        )}
        {!sdk && (
          <label className="check" title="입력창에 붙여넣기만 하고 Enter 는 안 누름 (아래 Enter 키로 나중에 제출)">
            <input type="checkbox" checked={!submit} onChange={(e) => setSubmit(!e.target.checked)} /> 붙여넣기만 (Enter 안 누름)
          </label>
        )}
        <label className="check" title="작업 중이어도 기다리지 않고 진행 중인 턴에 끼워넣음">
          <input type="checkbox" checked={now} onChange={(e) => setNow(e.target.checked)} /> 바로 끼워넣기 (--now)
        </label>
        <label className="check" title={sdk ? '질문/권한 답을 기다리는 중이어도 보냄' : '승인 대기 중이어도 보냄 (텍스트가 다이얼로그로 들어감)'}>
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> 강제 (--force)
        </label>
        <span className="spacer" />
        <button className="primary" onClick={send} disabled={busy || !text.trim() || tooBig}>
          {busy ? (wait ? '응답 기다리는 중…' : '보내는 중…') : '보내기'}
        </button>
      </div>

      {!sdk && (
        <>
          <div className="section-title">키 보내기</div>
          <div className="row wrap">
            {KEYS.map((k) => (
              <button key={k.label} className="ghost small" title={k.title} onClick={() => keys(k.keys)}>
                {k.label}
              </button>
            ))}
          </div>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const ks = customKeys.trim().split(/\s+/).filter(Boolean);
              if (ks.length) keys(ks).then(() => setCustomKeys(''));
            }}
          >
            <input
              className="grow"
              value={customKeys}
              onChange={(e) => setCustomKeys(e.target.value)}
              placeholder="tmux 키 직접 입력, 공백으로 구분 (예: C-u   Tab   1   Escape Escape)"
              aria-label="직접 보낼 키"
            />
            <button className="ghost small" disabled={!customKeys.trim()}>
              키 보내기
            </button>
          </form>
        </>
      )}

      {error && <div className="alert err">{error}</div>}
      {result && (
        <div className="result">
          <div className="row wrap small">
            {result.pasteOnly ? (
              <span className="badge info">붙여넣기만 함 — 아래 Enter 로 제출</span>
            ) : (
              <span className={`badge ${result.accepted ? 'ok' : 'err'}`}>{result.accepted ? '전달됨' : '수신 확인 안 됨'}</span>
            )}
            {result.interrupted && <span className="badge info">사람이 중단함</span>}
            {result.timedOut && <span className="badge warn">시간 초과 (부분 응답)</span>}
            {result.status && <span className="muted">상태: {result.status.state}</span>}
          </div>
          {result.last !== undefined && <pre className="reply">{result.last || '(텍스트 응답 없음)'}</pre>}
        </div>
      )}
    </div>
  );
}

// ---------- 결과 보고 ----------

const PHASE: Record<Report['phase'], string> = {
  dead: '죽음',
  starting: '준비 중',
  working: '작업 중',
  waiting: '승인 대기',
  done: '완료, 입력 대기',
  interrupted: '사람이 중단함',
};

export function ReportPanel({ name, version }: { name: string; version: number }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [showTools, setShowTools] = useState(false);

  const load = useCallback(() => {
    api.report(name).then(
      (r) => {
        setReport(r);
        setError('');
      },
      (e) => setError((e as Error).message),
    );
  }, [name]);
  // 세션 상태가 바뀔 때마다 (version) 다시 불러옴
  useEffect(load, [load, version]);

  if (error) return <div className="panel"><div className="alert err">{error}</div></div>;
  if (!report) return <div className="panel muted">불러오는 중…</div>;
  const t = report.turn;
  return (
    <div className="panel">
      <div className="row wrap">
        <span className="badge">{PHASE[report.phase]}</span>
        {report.status.trustPrompt && <span className="badge warn">신뢰 다이얼로그 대기</span>}
        {report.status.detail && <span className="muted small">{report.status.detail}</span>}
        {report.pending && report.pending.length > 0 && <span className="badge warn">답 기다리는 질문 {report.pending.length} — 대화 탭에서</span>}
        <span className="spacer" />
        <label className="check small">
          <input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} /> 도구 호출
        </label>
        <button className="ghost small" onClick={load}>
          새로고침
        </button>
      </div>
      {!t ? (
        <div className="empty">아직 대화 기록 없음</div>
      ) : (
        <>
          <div className="section-title">지시 <span className="muted small">{clock(t.promptAt)}</span></div>
          <pre className="prompt">{unwrapPasted(t.prompt)}</pre>
          {showTools && t.tools.length > 0 && (
            <>
              <div className="section-title">도구 {t.tools.length}회</div>
              <ul className="tools">
                {t.tools.map((c, i) => (
                  <li key={i}>
                    <b>{c.name}</b> <code>{c.input}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="section-title">
            응답 <span className="muted small">{clock(t.endedAt)}</span>
            {t.interrupted ? (
              <span className="badge info">중단됨, 부분 응답</span>
            ) : t.result?.is_error ? (
              <span className="badge err">오류 · {t.result.terminal_reason ?? t.result.subtype}</span>
            ) : (
              !t.complete && <span className="badge warn">진행 중, 부분 응답</span>
            )}
            {t.result && (
              <span className="muted small">
                {(t.result.duration_ms / 1000).toFixed(1)}초{t.result.total_cost_usd != null ? ` · $${t.result.total_cost_usd.toFixed(4)}` : ''}
              </span>
            )}
          </div>
          <pre className="reply">{t.texts.length ? t.texts.join('\n\n') : '(텍스트 응답 없음)'}</pre>
        </>
      )}
    </div>
  );
}

// ---------- 훅 이벤트 기록 ----------

export function EventsPanel({ name, version }: { name: string; version: number }) {
  const [events, setEvents] = useState<HookEvent[]>([]);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(300);
  useEffect(() => {
    api.events(name, limit).then(setEvents, (e) => setError((e as Error).message));
  }, [name, version, limit]);

  const detail = (e: HookEvent) => {
    const d = e.data as Record<string, string | undefined>;
    return d.prompt ?? d.toolInput ?? d.message ?? d.reason ?? d.source ?? '';
  };

  return (
    <div className="panel">
      <div className="row">
        <span className="muted small">최근 {events.length}개 (새 것부터)</span>
        <span className="spacer" />
        <label className="check small">
          개수
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[100, 300, 1000, 5000].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <div className="alert err">{error}</div>}
      {events.length === 0 ? (
        <div className="empty">기록 없음</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>시각</th>
                <th>이벤트</th>
                <th>도구</th>
                <th>내용</th>
              </tr>
            </thead>
            <tbody>
              {[...events].reverse().map((e) => (
                <tr key={e.id}>
                  <td className="mono nowrap">{clock(e.at)}</td>
                  <td className="nowrap">{e.event}</td>
                  <td className="nowrap">{e.tool ?? ''}</td>
                  <td className="clip">{String(detail(e)).replace(/\s+/g, ' ').slice(0, 200)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- 라우트 ----------

export function RoutesPanel({ name }: { name: string }) {
  const [routes, setRoutes] = useState<Route[]>([]);
  const [draft, setDraft] = useState<RouteInput>(emptyRoute());
  const [error, setError] = useState('');
  const load = useCallback(() => api.routes(name).then(setRoutes, (e) => setError((e as Error).message)), [name]);
  useEffect(() => {
    load();
  }, [load]);

  async function add() {
    setError('');
    try {
      await api.addRoute(name, draft);
      setDraft(emptyRoute());
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove(id: number) {
    try {
      await api.deleteRoute(id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="panel">
      {error && <div className="alert err">{error}</div>}
      {routes.length === 0 ? (
        <div className="empty small">라우트 없음 — 채널 메시지를 받지 않음</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>플랫폼</th>
                <th>채널</th>
                <th>매칭</th>
                <th>트리거</th>
                <th>자동 답장</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => (
                <tr key={r.id}>
                  <td>{r.platform === '*' ? '모두' : r.platform}</td>
                  <td>{r.channel ?? <span className="muted">아무 채널</span>}</td>
                  <td>{r.match}</td>
                  <td>{r.trigger ? <code>{r.trigger}</code> : <span className="muted">-</span>}</td>
                  <td>{r.auto_reply ? '예' : '아니오'}</td>
                  <td>
                    <button className="ghost small danger" onClick={() => remove(r.id)}>
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="section-title">라우트 추가</div>
      <div className="route-box">
        <RouteFields value={draft} onChange={setDraft} />
        <button className="primary small" onClick={add}>
          추가
        </button>
      </div>
    </div>
  );
}

// ---------- 화면 (tmux 화면 텍스트) ----------

export function ScreenPanel({ name }: { name: string }) {
  const [lines, setLines] = useState(0);
  const [auto, setAuto] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(
    () =>
      api.screen(name, lines).then(
        (r) => {
          setText(r.screen);
          setError('');
        },
        (e) => setError((e as Error).message),
      ),
    [name, lines],
  );
  useEffect(() => {
    load();
  }, [load]);
  useInterval(load, auto ? 2000 : null);

  return (
    <div className="panel wide">
      <div className="row wrap">
        <span className="muted small" title="Claude Code 는 대체 화면을 써서 tmux 스크롤백이 거의 없음. 대화 전체는 결과 탭(트랜스크립트)에서">
          tmux 화면을 텍스트로 (cardinal screen). 터미널에 붙지 않고 보기만 · Claude Code 는 대체 화면이라 스크롤백이 거의 없음 → 대화 전체는 “결과” 탭
        </span>
        <span className="spacer" />
        <label className="check small">
          스크롤백
          <select value={lines} onChange={(e) => setLines(Number(e.target.value))}>
            <option value={0}>지금 화면만</option>
            <option value={200}>+200줄</option>
            <option value={1000}>+1000줄</option>
            <option value={2000}>+2000줄</option>
          </select>
        </label>
        <label className="check small">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 2초마다 새로고침
        </label>
        <button className="ghost small" onClick={load}>
          새로고침
        </button>
      </div>
      {error && <div className="alert err">{error}</div>}
      <pre className="screen">{text}</pre>
    </div>
  );
}
