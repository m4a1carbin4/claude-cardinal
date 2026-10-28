import { Suspense, lazy, useEffect, useState } from 'react';
import { api } from '../api';
import { ago, clock, stateLabel } from '../format';
import type { Session } from '../types';
import { DrivePanel } from './DrivePanel';
import { LivePanel, McpPanel, SettingsPanel } from './SdkPanels';
import { EventsPanel, ReportPanel, RoutesPanel, ScreenPanel, SendPanel } from './SessionPanels';

// xterm 이 번들의 대부분이라 터미널 탭을 열 때만 불러옴
const TerminalView = lazy(() => import('./TerminalView').then((m) => ({ default: m.TerminalView })));

type Tab = 'terminal' | 'screen' | 'live' | 'send' | 'report' | 'drive' | 'events' | 'mcp' | 'settings' | 'routes';
const TMUX_TABS: { id: Tab; label: string }[] = [
  { id: 'terminal', label: '터미널' },
  { id: 'screen', label: '화면' },
  { id: 'send', label: '보내기' },
  { id: 'report', label: '결과' },
  { id: 'drive', label: '드라이브' },
  { id: 'events', label: '훅 이벤트' },
  { id: 'routes', label: '라우트' },
];
// SDK 세션은 화면(터미널)이 없고 메시지로 주고받음
const SDK_TABS: { id: Tab; label: string }[] = [
  { id: 'live', label: '대화' },
  { id: 'send', label: '보내기' },
  { id: 'report', label: '결과' },
  { id: 'drive', label: '드라이브' },
  { id: 'events', label: '훅 이벤트' },
  { id: 'mcp', label: 'MCP' },
  { id: 'settings', label: '설정' },
  { id: 'routes', label: '라우트' },
];

export function SessionView({ session, version, onGone }: { session: Session; version: number; onGone: () => void }) {
  const sdk = session.backend === 'sdk';
  const tabs = sdk ? SDK_TABS : TMUX_TABS;
  const [tab, setTab] = useState<Tab>(sdk ? 'live' : 'terminal');
  const [readonly, setReadonly] = useState(false);
  const [error, setError] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const st = stateLabel(session);
  const alive = session.alive && session.state !== 'ended';

  // 답 기다리는 질문 수 (다른 탭에 있어도 보이게). 상태가 바뀔 때마다 다시 셈
  useEffect(() => {
    if (!sdk) return;
    api.pending(session.name).then(
      (p) => setPendingCount(p.length),
      () => setPendingCount(0),
    );
  }, [sdk, session.name, session.state, version]);

  async function restart(resume: boolean, opts?: object) {
    setError('');
    try {
      await api.restart(session.name, { resume, sdk: opts });
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }

  async function interrupt() {
    setError('');
    try {
      await api.interrupt(session.name);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function kill(purge: boolean) {
    const msg = purge
      ? sdk
        ? `${session.name} 을(를) 종료하고 삭제됨으로 표시할까요? (다시 시작 못 함, DB 기록은 남음)`
        : `${session.name} 을(를) 종료하고 기록(meta·훅 폴더)도 지울까요? DB 기록은 남습니다.`
      : sdk
        ? `${session.name} 을(를) 종료할까요? (나중에 “다시 시작” 으로 대화를 이어갈 수 있음)`
        : `${session.name} 을(를) 종료할까요?`;
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
          {sdk && <span className="role sdk" title="tmux 없이 서버 안 Claude Agent SDK 로 도는 세션">SDK</span>}
          <span className={`badge ${st.tone}`}>{st.label}</span>
          {pendingCount > 0 && (
            <button className="badge warn as-link" onClick={() => setTab('live')} title="대화 탭에서 답하기">
              답 기다리는 질문 {pendingCount}
            </button>
          )}
          <span className="muted small">{ago(session.state_at)}</span>
        </div>
        <div className="sv-meta">
          <span title="작업 폴더">📁 <code>{session.cwd}</code></span>
          {sdk && session.sdk_options && (
            <span title="권한 모드 · 모델">
              {session.sdk_options.permission_mode} · {session.sdk_options.model ?? '기본 모델'}
            </span>
          )}
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
            <dd><code>{session.id}</code> {!sdk && <span className="muted small">(훅 폴더 이름)</span>}</dd>
            <dt>방식</dt>
            <dd>{sdk ? 'SDK (서버 안 Claude Agent SDK, 서버와 같이 살고 죽음)' : 'tmux + Claude Code'}</dd>
            <dt>카디널 도구</dt>
            <dd>
              {session.mcp ? (
                <>
                  카디널 MCP <code>mcp__cardinal__*</code>{' '}
                  <span className="muted small">({session.role === 'master' ? '마스터: 세션 만들기·보내기·기다리기 등 전부' : '워커: reply, 드라이브, 있는 워커 부르기'})</span>
                </>
              ) : (
                <>
                  cardinal CLI <span className="muted small">(서버 없이 띄운 세션)</span>
                </>
              )}
            </dd>
            {!sdk && (
              <>
                <dt>tmux</dt>
                <dd><code>{session.tmux}</code> {session.alive ? '' : <span className="muted">(없음)</span>}</dd>
              </>
            )}
            {sdk && session.sdk_options && (
              <>
                <dt>MCP 서버</dt>
                <dd>
                  cardinal
                  {Object.keys(session.sdk_options.mcp_servers ?? {}).map((n) => `, ${n}`)}
                  {session.sdk_options.strict_mcp_config ? <span className="muted small"> (strict: 이것만)</span> : <span className="muted small"> + 사용자/프로젝트 설정</span>}
                </dd>
                <dt>옵션</dt>
                <dd>
                  {[
                    session.sdk_options.partial && '글자 단위 스트리밍',
                    session.sdk_options.resume_on_start && '서버 시작 때 자동 재개',
                    session.sdk_options.question_timeout_s && `질문 답 제한 ${session.sdk_options.question_timeout_s}초`,
                    session.sdk_options.effort && `effort ${session.sdk_options.effort}`,
                  ]
                    .filter(Boolean)
                    .join(' · ') || <span className="muted">기본</span>}
                </dd>
              </>
            )}
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
            {!sdk && (
              <>
                <dt>claude 추가 인자</dt>
                <dd>{session.claude_args.length ? <code>{session.claude_args.join(' ')}</code> : <span className="muted">없음</span>}</dd>
              </>
            )}
            <dt>상태</dt>
            <dd>
              {session.state} · 마지막 훅 이벤트 {session.last_event ?? '-'} {session.tool ? `· 도구 ${session.tool}` : ''} · {clock(session.state_at)}
            </dd>
            <dt>만든 시각</dt>
            <dd>{new Date(session.created_at).toLocaleString('ko-KR')}</dd>
          </dl>
        </details>
        <div className="sv-actions">
          {sdk && (
            <>
              <button className="ghost small" onClick={interrupt} disabled={!alive || (session.state !== 'busy' && session.state !== 'waiting')} title="진행 중인 턴 중단">
                중단
              </button>
              <button
                className="ghost small"
                onClick={() => (alive ? confirm(`${session.name} 을(를) 다시 시작할까요? (대화는 이어짐)`) : true) && restart(true).catch(() => {})}
                title="대화를 이어서 다시 띄움"
              >
                다시 시작
              </button>
            </>
          )}
          {!sdk && !session.alive && (
            <button className="ghost small" onClick={() => restart(true).catch(() => {})} title="tmux 를 다시 띄우고 같은 claude 대화를 이어감 (cardinal revive)">
              다시 시작
            </button>
          )}
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
        {tabs.map((t) => (
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
      <div className={`tab-body ${tab === 'terminal' || tab === 'live' ? 'no-scroll' : ''}`}>
        {tab === 'terminal' &&
          (session.alive ? (
            <Suspense fallback={<div className="empty">터미널 불러오는 중…</div>}>
              <TerminalView key={`${session.id}-${readonly}`} name={session.name} readonly={readonly} />
            </Suspense>
          ) : (
            <div className="empty">세션이 살아있지 않음</div>
          ))}
        {tab === 'screen' && <ScreenPanel name={session.name} />}
        {tab === 'live' && <LivePanel session={session} onRestart={(resume) => restart(resume).catch(() => {})} />}
        {tab === 'send' && <SendPanel name={session.name} sdk={sdk} />}
        {tab === 'report' && <ReportPanel name={session.name} version={version} />}
        {tab === 'drive' && <DrivePanel key={session.name} root={`/sessions/${session.name}`} />}
        {tab === 'events' && <EventsPanel name={session.name} version={version} />}
        {tab === 'mcp' && <McpPanel name={session.name} alive={alive} />}
        {tab === 'settings' && <SettingsPanel session={session} onRestart={restart} />}
        {tab === 'routes' && <RoutesPanel name={session.name} />}
      </div>
    </div>
  );
}
