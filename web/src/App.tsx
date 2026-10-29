import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, hasToken, setToken } from './api';
import { ChannelPanel } from './components/ChannelPanel';
import { CreateSession } from './components/CreateSession';
import { DrivePanel } from './components/DrivePanel';
import { SessionList } from './components/SessionList';
import { SessionView } from './components/SessionView';
import { DRIVE_EVENT, useInterval, useJsonSocket } from './hooks';
import type { Health, Session } from './types';

type View = 'sessions' | 'channel' | 'drive';

const SEL_KEY = 'cardinal.selected';
// 주소 해시로 화면 고르기: #s=<세션 이름> / #channel / #drive (북마크·링크 공유용)
const fromHash = (): { view: View; session: string | null } => {
  const h = location.hash.slice(1);
  if (h === 'channel' || h === 'drive') return { view: h, session: null };
  const m = /^s=(.+)$/.exec(h);
  return { view: 'sessions', session: m ? decodeURIComponent(m[1]) : null };
};
const readSel = () => {
  const h = fromHash().session;
  if (h) return h;
  try {
    return localStorage.getItem(SEL_KEY);
  } catch {
    return null;
  }
};

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(readSel);
  const [view, setView] = useState<View>(() => fromHash().view);
  const [creating, setCreating] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [version, setVersion] = useState(0); // 세션 목록이 바뀔 때마다 올라감 → 상세 탭들이 다시 불러옴

  const handleErr = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) setNeedToken(true);
  }, []);

  const loadAll = useCallback(() => {
    api.sessions(true).then((s) => {
      setSessions(s);
      setNeedToken(false);
    }, handleErr);
    api.health().then(setHealth, handleErr);
  }, [handleErr]);

  useEffect(loadAll, [loadAll]);

  // 화면 상태를 주소 해시에 반영, 뒤로 가기 등으로 해시가 바뀌면 따라감
  useEffect(() => {
    const h = view !== 'sessions' ? `#${view}` : selected ? `#s=${encodeURIComponent(selected)}` : '';
    if (location.hash !== h) history.replaceState(null, '', h || location.pathname + location.search);
  }, [view, selected]);
  useEffect(() => {
    const onHash = () => {
      const h = fromHash();
      setView(h.view);
      if (h.session) setSelected(h.session);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useInterval(() => api.health().then(setHealth, handleErr), 10_000);

  // 서버가 세션 목록이 바뀔 때마다 푸시. 삭제된 것까지 보려면 REST 로 한 번 더
  const live = useJsonSocket(needToken ? null : '/ws/events', (m) => {
    // 드라이브 폴더가 바뀜 → 그 폴더를 보고 있는 화면들이 다시 읽음 (useDriveChanged)
    if (m.type === 'drive') window.dispatchEvent(new CustomEvent(DRIVE_EVENT, { detail: m.path }));
    if (m.type !== 'sessions') return;
    setVersion((v) => v + 1);
    if (showDeleted) api.sessions(true).then(setSessions, handleErr);
    else
      setSessions((prev) => {
        const deleted = prev.filter((s) => s.deleted_at);
        return [...(m.sessions as Session[]), ...deleted];
      });
  });

  const select = (name: string) => {
    setSelected(name);
    setView('sessions');
    try {
      localStorage.setItem(SEL_KEY, name);
    } catch {
      // 무시
    }
  };

  const current = useMemo(() => sessions.find((s) => s.name === selected && !s.deleted_at) ?? null, [sessions, selected]);
  const counts = useMemo(() => {
    const alive = sessions.filter((s) => !s.deleted_at && s.alive);
    return { alive: alive.length, busy: alive.filter((s) => s.state === 'busy').length };
  }, [sessions]);

  function saveToken(e: React.FormEvent) {
    e.preventDefault();
    setToken(tokenInput.trim());
    setTokenInput('');
    loadAll();
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/banner.png" alt="" />
          <span>Cardinal</span>
        </div>
        <nav className="views">
          <button className={view === 'sessions' ? 'on' : ''} onClick={() => setView('sessions')}>
            세션
          </button>
          <button className={view === 'channel' ? 'on' : ''} onClick={() => setView('channel')}>
            채널
          </button>
          <button className={view === 'drive' ? 'on' : ''} onClick={() => setView('drive')}>
            드라이브
          </button>
        </nav>
        <span className="spacer" />
        <div className="status-chips">
          <span className="chip" title="실시간 상태 연결">
            <span className={`dot ${live ? 'ok' : 'muted'}`} /> 실시간
          </span>
          <span className="chip">
            살아있음 {counts.alive} · 작업 중 {counts.busy}
          </span>
          {health?.sdk?.enabled && (
            <span className="chip" title="서버가 SDK 모드 (새 세션 기본이 서버 안 Agent SDK)">
              <span className="dot info" /> SDK 모드 · {health.sdk.alive}
            </span>
          )}
          {health && <ChannelChip label="디스코드" status={health.channels.discord} />}
          {health?.channels.slack && health.channels.slack !== 'off' && <ChannelChip label="슬랙" status={health.channels.slack} />}
          <button className="ghost small" onClick={() => setNeedToken(true)} title="서버 토큰 (CARDINAL_TOKEN)">
            {hasToken() ? '🔑 토큰' : '토큰'}
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <button className="primary block" onClick={() => setCreating(true)}>
            + 새 세션
          </button>
          <SessionList
            sessions={sessions}
            selected={selected}
            onSelect={select}
            showDeleted={showDeleted}
            onToggleDeleted={(v) => {
              setShowDeleted(v);
              api.sessions(true).then(setSessions, handleErr);
            }}
          />
        </aside>

        <main className="main">
          {view === 'channel' ? (
            <ChannelPanel sessions={sessions} />
          ) : view === 'drive' ? (
            <div className="drive-view">
              <DrivePanel />
            </div>
          ) : current ? (
            <SessionView key={current.id} session={current} version={version} onGone={() => setSelected(null)} />
          ) : (
            <div className="welcome">
              <img src="/banner.png" alt="" />
              <h2>세션을 고르거나 새로 만드세요</h2>
              <p className="muted">
                왼쪽 목록에서 세션을 고르면 터미널·메시지·결과·훅 이벤트·라우트를 볼 수 있어요. SDK 세션은 터미널 대신 대화·MCP·설정 탭이 있어요. 채널 이벤트는 위의 “채널” 탭에서.
              </p>
            </div>
          )}
        </main>
      </div>

      {creating && (
        <CreateSession
          health={health}
          onClose={() => setCreating(false)}
          onCreated={(name) => {
            setCreating(false);
            select(name);
            loadAll();
          }}
        />
      )}

      {needToken && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && hasToken() && setNeedToken(false)}>
          <form className="modal narrow" onSubmit={saveToken}>
            <h2>서버 토큰</h2>
            <p className="muted small">
              서버를 <code>CARDINAL_TOKEN</code> 으로 띄웠다면 그 값을 넣으세요. 이 브라우저에만 저장돼요. 주소에 <code>?token=…</code> 을 붙여 열어도 돼요.
            </p>
            <input type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="토큰" autoFocus />
            <div className="modal-foot">
              {hasToken() && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setToken(null);
                    setNeedToken(false);
                    loadAll();
                  }}
                >
                  토큰 지우기
                </button>
              )}
              <button className="primary" disabled={!tokenInput.trim()}>
                저장
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// 외부 채널 연결 상태 (connecting / ready / failed: … / closed / off)
function ChannelChip({ label, status }: { label: string; status: string }) {
  const failed = status.startsWith('failed');
  const tone = status === 'ready' ? 'ok' : status === 'off' ? 'muted' : failed ? 'err' : 'info';
  return (
    <span className="chip" title={`${label}: ${status}`}>
      <span className={`dot ${tone}`} />
      {label} {failed ? '실패' : status}
    </span>
  );
}
