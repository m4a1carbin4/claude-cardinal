import { Suspense, lazy, useState } from 'react';
import { api } from '../api';
import { ago, clock, stateLabel } from '../format';
import type { Session } from '../types';
import { EventsPanel, ReportPanel, RoutesPanel, ScreenPanel, SendPanel } from './SessionPanels';

// xterm 이 번들의 대부분이라 터미널 탭을 열 때만 불러옴
const TerminalView = lazy(() => import('./TerminalView').then((m) => ({ default: m.TerminalView })));

type Tab = 'terminal' | 'screen' | 'send' | 'report' | 'events' | 'routes';
const TABS: { id: Tab; label: string }[] = [
  { id: 'terminal', label: '터미널' },
  { id: 'screen', label: '화면' },
  { id: 'send', label: '보내기' },
  { id: 'report', label: '결과' },
  { id: 'events', label: '훅 이벤트' },
  { id: 'routes', label: '라우트' },
];

export function SessionView({ session, version, onGone }: { session: Session; version: number; onGone: () => void }) {
  const [tab, setTab] = useState<Tab>('terminal');
  const [readonly, setReadonly] = useState(false);
  const [error, setError] = useState('');
  const st = stateLabel(session);

  async function kill(purge: boolean) {
    const msg = purge ? `${session.name} 을(를) 종료하고 기록(meta·훅 폴더)도 지울까요? DB 기록은 남습니다.` : `${session.name} 을(를) 종료할까요?`;
    if (!confirm(msg)) return;
    try {
      await api.kill(session.name, purge);
      if (purge) onGone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="session-view">
      <div className="sv-head">
        <div className="sv-title">
          <h2>{session.name}</h2>
          <span className={`role ${session.role}`}>{session.role}</span>
          <span className={`badge ${st.tone}`}>{st.label}</span>
          <span className="muted small">{ago(session.state_at)}</span>
        </div>
        <div className="sv-meta">
          <span title="작업 폴더">📁 <code>{session.cwd}</code></span>
          <span title="지금 claude 세션 ID (/clear 하면 바뀜)">
            claude <code>{(session.claude_session_id ?? '').slice(0, 8)}</code>
          </span>
          <span title="세션 고유 키 (훅 폴더 이름)">
            id <code>{session.id.slice(0, 8)}</code>
          </span>
          {session.detail && <span className="muted">{session.detail}</span>}
        </div>
        <details className="sv-info">
          <summary>세션 정보</summary>
          <dl>
            <dt>세션 고유 키</dt>
            <dd><code>{session.id}</code> <span className="muted small">(훅 폴더 이름)</span></dd>
            <dt>tmux</dt>
            <dd><code>{session.tmux}</code> {session.alive ? '' : <span className="muted">(없음)</span>}</dd>
            <dt>claude 세션 ID</dt>
            <dd><code>{session.claude_session_id ?? '-'}</code> <span className="muted small">(/clear 하면 바뀜)</span></dd>
            <dt>작업 폴더</dt>
            <dd><code>{session.cwd}</code></dd>
            <dt>만든 세션</dt>
            <dd>
              {session.parent_name ? (
                <>
                  <a href={`#s=${encodeURIComponent(session.parent_name)}`}>{session.parent_name}</a>{' '}
                  <span className="muted small">(작업 폴더를 물려받음, <code>{(session.parent_id ?? '').slice(0, 8)}</code>)</span>
                </>
              ) : (
                <span className="muted">없음 (사람/API가 만듦)</span>
              )}
            </dd>
            <dt>트랜스크립트</dt>
            <dd><code>{session.transcript_path ?? '-'}</code></dd>
            <dt>claude 추가 인자</dt>
            <dd>{session.claude_args.length ? <code>{session.claude_args.join(' ')}</code> : <span className="muted">없음</span>}</dd>
            <dt>상태</dt>
            <dd>
              {session.state} · 마지막 훅 이벤트 {session.last_event ?? '-'} {session.tool ? `· 도구 ${session.tool}` : ''} · {clock(session.state_at)}
            </dd>
            <dt>만든 시각</dt>
            <dd>{new Date(session.created_at).toLocaleString('ko-KR')}</dd>
          </dl>
        </details>
        <div className="sv-actions">
          <button className="ghost small" onClick={() => kill(false)} disabled={!session.alive}>
            종료
          </button>
          <button className="ghost small danger" onClick={() => kill(true)}>
            종료 + 기록 삭제
          </button>
        </div>
      </div>
      {error && <div className="alert err">{error}</div>}

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        {tab === 'terminal' && (
          <label className="check small tab-extra" title="입력 안 받고 창 크기에도 영향 안 줌">
            <input type="checkbox" checked={readonly} onChange={(e) => setReadonly(e.target.checked)} /> 관전 모드
          </label>
        )}
      </div>

      {/* 터미널 탭은 스크롤바가 생기면 안 됨: 스크롤바가 폭을 줄였다 늘렸다 하면서 크기 맞추기가 끝없이 반복돼 깜빡임 */}
      <div className={`tab-body ${tab === 'terminal' ? 'no-scroll' : ''}`}>
        {tab === 'terminal' &&
          (session.alive ? (
            <Suspense fallback={<div className="empty">터미널 불러오는 중…</div>}>
              <TerminalView key={`${session.id}-${readonly}`} name={session.name} readonly={readonly} />
            </Suspense>
          ) : (
            <div className="empty">세션이 살아있지 않음</div>
          ))}
        {tab === 'screen' && <ScreenPanel name={session.name} />}
        {tab === 'send' && <SendPanel name={session.name} />}
        {tab === 'report' && <ReportPanel name={session.name} version={version} />}
        {tab === 'events' && <EventsPanel name={session.name} version={version} />}
        {tab === 'routes' && <RoutesPanel name={session.name} />}
      </div>
    </div>
  );
}
