import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { clock } from '../format';
import { useSocket } from '../hooks';
import type { AskQuestion, ContextUsage, McpStatus, Pending, PermissionMode, SdkTurnRow, Session, State, TurnResult } from '../types';
import { AttachBar, attachHandlers, useAttachments } from './AttachBar';
import { MicInput } from './MicInput';
import { PERMISSION_MODES, SdkOptionsFields, formFromOptions, toOptions } from './SdkOptionsFields';

// ---------- 질문 / 권한 답하기 ----------

function QuestionForm({ name, p, onDone }: { name: string; p: Pending; onDone: () => void }) {
  const questions = ((p.input.questions as AskQuestion[] | undefined) ?? []).filter((q) => q && q.question);
  // 질문마다 고른 라벨들 + 직접 입력
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const answerOf = (q: AskQuestion) => {
    const f = (free[q.question] ?? '').trim();
    if (f) return f;
    return (picked[q.question] ?? []).join(', ');
  };
  const ready = questions.length > 0 && questions.every((q) => answerOf(q));

  function toggle(q: AskQuestion, label: string) {
    const cur = picked[q.question] ?? [];
    const next = q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
    setPicked({ ...picked, [q.question]: next });
    setFree({ ...free, [q.question]: '' });
  }

  async function submit(allow: boolean) {
    setBusy(true);
    setError('');
    try {
      const answers = Object.fromEntries(questions.map((q) => [q.question, answerOf(q)]));
      await api.answer(name, p.id, allow ? { answers } : { allow: false });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {questions.map((q) => (
        <div key={q.question} className="question">
          <div className="q-text">
            {q.header && <span className="badge info">{q.header}</span>} {q.question}
            {q.multiSelect && <span className="muted small"> (여러 개 고를 수 있음)</span>}
          </div>
          <div className="q-options">
            {(q.options ?? []).map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label) && !(free[q.question] ?? '').trim();
              return (
                <button key={o.label} type="button" className={`q-option ${on ? 'on' : ''}`} onClick={() => toggle(q, o.label)} disabled={busy}>
                  <b>{o.label}</b>
                  {o.description && <span className="muted small">{o.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            value={free[q.question] ?? ''}
            onChange={(e) => setFree({ ...free, [q.question]: e.target.value })}
            placeholder="직접 입력 (쓰면 위 선택 대신 이걸 보냄)"
            disabled={busy}
          />
        </div>
      ))}
      {questions.length === 0 && <pre className="prompt">{JSON.stringify(p.input, null, 2)}</pre>}
      {error && <div className="alert err">{error}</div>}
      <div className="row wrap">
        <button className="primary small" disabled={busy || !ready} onClick={() => submit(true)}>
          답하기
        </button>
        <button className="ghost small" disabled={busy} onClick={() => submit(false)} title="답 안 함 → 에이전트가 스스로 판단해서 진행">
          답 안 함 (스스로 판단)
        </button>
      </div>
    </>
  );
}

function PermissionForm({ name, p, onDone }: { name: string; p: Pending; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(allow: boolean) {
    setBusy(true);
    setError('');
    try {
      await api.answer(name, p.id, allow ? { allow: true } : { allow: false, message: reason.trim() || undefined });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {p.description && <div className="small">{p.description}</div>}
      <pre className="prompt mono small">{JSON.stringify(p.input, null, 2)}</pre>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="거부 사유 (선택, claude 에게 전달)" disabled={busy} />
      {error && <div className="alert err">{error}</div>}
      <div className="row wrap">
        <button className="primary small" disabled={busy} onClick={() => submit(true)}>
          허용
        </button>
        <button className="ghost small danger" disabled={busy} onClick={() => submit(false)}>
          거부
        </button>
      </div>
    </>
  );
}

export function PendingCard({ name, p, onDone }: { name: string; p: Pending; onDone: () => void }) {
  return (
    <div className="pending-card">
      <div className="row wrap small">
        <span className="badge warn">{p.kind === 'question' ? '질문' : '권한 확인'}</span>
        <b>{p.title ?? p.tool}</b>
        <span className="spacer" />
        <span className="muted">{clock(p.created_at)}</span>
      </div>
      {p.kind === 'question' ? <QuestionForm name={name} p={p} onDone={onDone} /> : <PermissionForm name={name} p={p} onDone={onDone} />}
    </div>
  );
}

// ---------- 턴 하나 ----------

function resultMeta(r: TurnResult | null | undefined): string {
  if (!r) return '';
  const parts = [`${(r.duration_ms / 1000).toFixed(1)}초`];
  if (r.total_cost_usd != null) parts.push(`$${r.total_cost_usd.toFixed(4)}`);
  if (r.num_turns) parts.push(`${r.num_turns}스텝`);
  return parts.join(' · ');
}

function TurnView({ t }: { t: SdkTurnRow }) {
  const r = t.result;
  return (
    <div className="turn">
      {t.origin === 'agent' ? (
        <div className="bubble agent-start muted small">에이전트가 스스로 시작한 턴 (백그라운드 작업 알림 등)</div>
      ) : (
        <div className="bubble user">
          <div className="b-meta">{clock(t.prompt_at)}</div>
          {t.prompt}
        </div>
      )}
      {t.tools.length > 0 && (
        <details className="tool-calls">
          <summary>도구 {t.tools.length}회 · {[...new Set(t.tools.map((x) => x.name))].slice(0, 6).join(', ')}</summary>
          <ul className="tools">
            {t.tools.map((c, i) => (
              <li key={i}>
                <b>{c.name}</b> <code>{c.input}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="bubble assistant">
        {t.texts.length ? t.texts.join('\n\n') : <span className="muted">{t.ended_at ? '(텍스트 응답 없음)' : '진행 중…'}</span>}
        <div className="b-meta">
          {t.interrupted && <span className="badge info">중단됨</span>}
          {r?.is_error && !t.interrupted && <span className="badge err">오류 · {r.terminal_reason ?? r.subtype}</span>}
          {!t.ended_at && <span className="badge busy">진행 중</span>}
          <span>{clock(t.ended_at)}</span>
          <span>{resultMeta(r)}</span>
        </div>
      </div>
    </div>
  );
}

// ---------- 대화 (실시간) ----------

// 지금 진행 중인 턴에서 들어오는 것 (턴이 끝나면 기록으로 넘어감)
type LiveItem =
  | { k: 'text'; text: string }
  | { k: 'tool'; id: string; name: string; input: string; result?: string; error?: boolean }
  | { k: 'note'; text: string };

interface SdkStatus {
  state: State;
  event?: string | null;
  detail?: string | null;
  tool?: string | null;
  alive: boolean;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

function blockText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : (b as { text?: string }).text ?? '')).join('\n');
  return c == null ? '' : JSON.stringify(c);
}

export function LivePanel({ session, onRestart }: { session: Session; onRestart: (resume: boolean) => void }) {
  const name = session.name;
  const [turns, setTurns] = useState<SdkTurnRow[]>([]);
  const [limit, setLimit] = useState(30);
  const [live, setLive] = useState<LiveItem[]>([]);
  const [streaming, setStreaming] = useState('');
  const [queued, setQueued] = useState<{ id: string; text: string; files?: string[] }[]>([]);
  const [pending, setPending] = useState<Pending[]>(session.pending ?? []);
  const [status, setStatus] = useState<SdkStatus>({ state: session.state, alive: session.alive, tool: session.tool, detail: session.detail });
  const [text, setText] = useState('');
  const [now, setNow] = useState(false);
  const [force, setForce] = useState(false);
  const [error, setError] = useState('');
  const att = useAttachments(name);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // 맨 아래 보고 있으면 새 내용이 와도 따라 내려감

  const loadTurns = useCallback(() => {
    api.turns(name, limit).then(setTurns, (e) => setError((e as Error).message));
  }, [name, limit]);
  useEffect(loadTurns, [loadTurns]);

  const { connected, send } = useSocket(`/ws/sdk/${encodeURIComponent(name)}`, (m) => {
    switch (m.type) {
      case 'hello':
        setStatus(m.status);
        setPending(m.pending ?? []);
        loadTurns();
        break;
      case 'state':
        setStatus(m);
        break;
      case 'pending':
        setPending((ps) => [...ps.filter((x) => x.id !== m.pending.id), m.pending]);
        break;
      case 'pending_done':
        setPending((ps) => ps.filter((x) => x.id !== m.id));
        break;
      case 'turn':
        // 이 턴의 실시간 내용은 기록으로 넘어감
        setLive([]);
        setStreaming('');
        setQueued((q) => {
          // 첨부가 있으면 서버가 지시 뒤에 첨부 안내를 붙여서 앞부분만 같음
          const p = String(m.turn.prompt ?? '');
          const i = q.findIndex((x) => x.text === p || (!!x.files?.length && p.startsWith(x.text)));
          return i < 0 ? q : [...q.slice(0, i), ...q.slice(i + 1)];
        });
        loadTurns();
        break;
      case 'result':
        if (!m.ok) setError(m.error ?? '실패');
        break;
      case 'message':
        onSdkMessage(m.message);
        break;
    }
  });

  function onSdkMessage(msg: any) {
    if (msg.parent_tool_use_id) return; // 서브에이전트 것은 빼고 메인 에이전트만
    if (msg.type === 'StreamEvent') {
      const ev = msg.event ?? {};
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') setStreaming((s) => s + ev.delta.text);
      return;
    }
    if (msg.type === 'AssistantMessage') {
      setStreaming('');
      const add: LiveItem[] = [];
      for (const b of msg.content ?? []) {
        if (b.type === 'TextBlock' && b.text) add.push({ k: 'text', text: b.text });
        else if (b.type === 'ToolUseBlock') add.push({ k: 'tool', id: b.id, name: b.name, input: clip(JSON.stringify(b.input ?? {}), 400) });
      }
      if (msg.error) add.push({ k: 'note', text: `오류: ${msg.error}` });
      if (add.length) setLive((l) => [...l, ...add]);
      return;
    }
    if (msg.type === 'UserMessage' && Array.isArray(msg.content)) {
      const results = msg.content.filter((b: any) => b.type === 'ToolResultBlock');
      if (!results.length) return;
      setLive((l) =>
        l.map((it) => {
          const r = it.k === 'tool' && results.find((b: any) => b.tool_use_id === it.id);
          return r ? { ...it, result: clip(blockText(r.content), 600), error: !!r.is_error } : it;
        }),
      );
      return;
    }
    if (msg.type === 'SystemMessage' && msg.subtype === 'compact_boundary') setLive((l) => [...l, { k: 'note', text: '대화 압축됨 (compact)' }]);
  }

  // 새 내용이 오면 맨 아래로 (사용자가 위로 올려 보고 있으면 그대로)
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns, live, streaming, queued, pending]);

  // override: 음성 입력에서 "바로 보내기" 로 넘어온 글 (입력창 내용 대신)
  // 첨부는 드라이브 경로만 보냄 (서버가 지시 뒤에 안내를 붙임)
  async function submit(override?: string) {
    const t = (override ?? text).trim();
    const attachments = att.paths;
    if ((!t && !attachments.length) || att.uploading) return;
    setError('');
    const id = `w${Date.now().toString(36)}`;
    const msg = { type: 'send', id, text: t, attachments, wait: false, now, force };
    const files = att.items.map((x) => x.name);
    const sent = () => {
      setQueued((q) => [...q, { id, text: t, files }]);
      if (override === undefined) setText('');
      att.clear();
    };
    stick.current = true;
    if (send(msg)) {
      sent();
      return;
    }
    // 소켓이 끊겨 있으면 REST 로
    try {
      await api.send(name, { text: t, attachments, wait: false, now, force });
      sent();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function interrupt() {
    setError('');
    try {
      await api.interrupt(name);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const alive = status.alive && status.state !== 'ended';
  const working = alive && (status.state === 'busy' || status.state === 'waiting');

  return (
    <div className="live">
      <div
        className="live-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {turns.length >= limit && (
          <button className="ghost small more-btn" onClick={() => setLimit(limit + 30)}>
            이전 턴 더 보기
          </button>
        )}
        {turns.length === 0 && !live.length && !queued.length && <div className="empty">아직 대화 없음. 아래에서 첫 메시지를 보내 보세요.</div>}
        {turns.map((t) => (
          <TurnView key={t.id} t={t} />
        ))}
        {queued.map((q) => (
          <div key={q.id} className="bubble user queued">
            <div className="b-meta">보냄 · 차례 기다리는 중이거나 처리 중</div>
            {q.text}
            {!!q.files?.length && <div className="b-meta">📎 {q.files.join(', ')}</div>}
          </div>
        ))}
        {(live.length > 0 || streaming) && (
          <div className="turn live-turn">
            {live.map((it, i) =>
              it.k === 'text' ? (
                <div key={i} className="bubble assistant">
                  {it.text}
                </div>
              ) : it.k === 'tool' ? (
                <div key={i} className={`live-tool ${it.error ? 'err' : ''}`}>
                  <b>{it.name}</b> <code>{it.input}</code>
                  {it.result !== undefined ? <pre>{it.result || '(결과 없음)'}</pre> : <span className="muted small"> 실행 중…</span>}
                </div>
              ) : (
                <div key={i} className="muted small">
                  {it.text}
                </div>
              ),
            )}
            {streaming && <div className="bubble assistant streaming">{streaming}</div>}
          </div>
        )}
        {pending.map((p) => (
          <PendingCard key={p.id} name={name} p={p} onDone={() => setPending((ps) => ps.filter((x) => x.id !== p.id))} />
        ))}
      </div>

      <div className="composer">
        <div className="row wrap small">
          <span className={`dot ${connected ? 'ok' : 'muted'}`} title="실시간 연결 (/ws/sdk)" />
          <span className="muted">
            {!alive ? '세션 끝남' : status.state === 'busy' ? `작업 중${status.tool ? ` · ${status.tool}` : ''}` : status.state === 'waiting' ? (status.detail ?? '답 기다리는 중') : status.state === 'starting' ? '준비 중' : '대기'}
          </span>
          <span className="spacer" />
          <label className="check" title="작업 중이어도 기다리지 않고 진행 중인 턴에 끼워넣음">
            <input type="checkbox" checked={now} onChange={(e) => setNow(e.target.checked)} /> 바로 끼워넣기
          </label>
          <label className="check" title="질문/권한 답을 기다리는 중이어도 보냄">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> 강제
          </label>
        </div>
        {error && <div className="alert err">{error}</div>}
        {alive && (
          <MicInput
            onText={(t, autoSend) =>
              autoSend ? void submit(t) : setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${t}` : t))
            }
          />
        )}
        {alive && <AttachBar session={name} att={att} />}
        {alive ? (
          <div className="row" {...attachHandlers(att)}>
            <textarea
              className="grow"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="메시지 (Enter 보내기, Shift+Enter 줄바꿈). 파일은 끌어 놓거나 붙여넣기. 작업 중이면 끝난 뒤 차례로 들어감"
            />
            <div className="col">
              <button className="primary" onClick={() => submit()} disabled={(!text.trim() && !att.items.length) || att.uploading}>
                보내기
              </button>
              <button className="ghost small danger" onClick={interrupt} disabled={!working} title="진행 중인 턴 중단 (tmux 의 Esc)">
                중단
              </button>
            </div>
          </div>
        ) : (
          <div className="row wrap">
            <span className="muted small">{session.detail ?? '세션이 끝났어요.'}</span>
            <span className="spacer" />
            <button className="primary small" onClick={() => onRestart(true)}>
              이어서 다시 시작
            </button>
            <button className="ghost small" onClick={() => onRestart(false)}>
              새 대화로 시작
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- MCP ----------

const MCP_TONE: Record<string, string> = { connected: 'ok', failed: 'err', 'needs-auth': 'warn', pending: 'info', disabled: 'muted' };

export function McpPanel({ name, alive }: { name: string; alive: boolean }) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    if (!alive) return;
    api.mcp(name).then(
      (s) => {
        setStatus(s);
        setError('');
      },
      (e) => setError((e as Error).message),
    );
  }, [name, alive]);
  useEffect(load, [load]);

  async function act(server: string, action: 'reconnect' | 'enable' | 'disable') {
    setBusy(server);
    setError('');
    try {
      setStatus(await api.mcpAction(name, server, action));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  if (!alive) return <div className="panel"><div className="empty">세션이 살아있을 때만 MCP 상태를 볼 수 있어요</div></div>;
  return (
    <div className="panel">
      <div className="row">
        <span className="muted small">이 세션에 붙은 MCP 서버. 서버를 추가/제거하려면 “설정” 탭에서 다시 시작</span>
        <span className="spacer" />
        <button className="ghost small" onClick={load}>
          새로고침
        </button>
      </div>
      {error && <div className="alert err">{error}</div>}
      {!status ? (
        <div className="muted">불러오는 중…</div>
      ) : status.mcpServers.length === 0 ? (
        <div className="empty">MCP 서버 없음</div>
      ) : (
        <ul className="mcp-list">
          {status.mcpServers.map((s) => (
            <li key={s.name} className="mcp">
              <div className="row wrap">
                <span className={`dot ${MCP_TONE[s.status] ?? 'muted'}`} />
                <b>{s.name}</b>
                <span className={`badge ${MCP_TONE[s.status] ?? ''}`}>{s.status}</span>
                {s.scope && <span className="muted small">{s.scope}</span>}
                {s.serverInfo && (
                  <span className="muted small">
                    {s.serverInfo.name} {s.serverInfo.version}
                  </span>
                )}
                <span className="spacer" />
                {s.name !== 'cardinal' && (
                  <>
                    <button className="ghost small" disabled={busy === s.name} onClick={() => act(s.name, 'reconnect')}>
                      다시 연결
                    </button>
                    {s.status === 'disabled' ? (
                      <button className="ghost small" disabled={busy === s.name} onClick={() => act(s.name, 'enable')}>
                        켜기
                      </button>
                    ) : (
                      <button className="ghost small" disabled={busy === s.name} onClick={() => act(s.name, 'disable')}>
                        끄기
                      </button>
                    )}
                  </>
                )}
              </div>
              {s.error && <div className="alert err small">{s.error}</div>}
              {s.tools && s.tools.length > 0 && (
                <details>
                  <summary className="small muted">도구 {s.tools.length}개</summary>
                  <ul className="tools">
                    {s.tools.map((t) => (
                      <li key={t.name}>
                        <code>{t.name}</code> <span className="muted">{t.description ? clip(t.description, 140) : ''}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- 설정 (모델/권한 모드/컨텍스트/다시 시작) ----------

// 컨텍스트 항목의 color 는 Claude Code 테마 이름(promptBorder 등)이라 CSS 로 못 씀 → 순서대로 우리 색
const CTX_COLORS = ['var(--accent)', 'var(--info)', 'var(--ok)', 'var(--busy)', 'var(--err)', 'var(--muted)', '#9b7fd1', '#4fb3a9'];
const isFree = (n: string) => /free space/i.test(n);

export function SettingsPanel({ session, onRestart }: { session: Session; onRestart: (resume: boolean, sdk?: object) => Promise<void> }) {
  const name = session.name;
  const opts = session.sdk_options;
  const alive = session.alive && session.state !== 'ended';
  const [model, setModel] = useState(opts?.model ?? '');
  const [mode, setMode] = useState<PermissionMode>(opts?.permission_mode ?? 'auto');
  const [ctx, setCtx] = useState<ContextUsage | null>(null);
  const [form, setForm] = useState(() => formFromOptions(opts));
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadCtx = useCallback(() => {
    if (alive) api.context(name).then(setCtx, (e) => setError((e as Error).message));
  }, [name, alive]);
  useEffect(loadCtx, [loadCtx]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      await fn();
      setMsg(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function restart(resume: boolean) {
    const { options, error: err } = toOptions(form);
    if (err) return setError(err);
    if (!confirm(resume ? `${name} 을(를) 이 옵션으로 다시 시작할까요? (대화는 이어짐, 진행 중인 턴은 끊김)` : `${name} 을(를) 새 대화로 다시 시작할까요? (이전 대화 기억 없음)`)) return;
    run(() => onRestart(resume, options), '다시 시작함');
  }

  return (
    <div className="panel">
      {msg && <div className="badge ok">{msg}</div>}
      {error && <div className="alert err">{error}</div>}

      <div className="section-title">지금 세션에 바로 적용</div>
      {!alive && <div className="muted small">세션이 끝나 있어요. 아래 “다시 시작” 으로 띄우세요.</div>}
      <div className="row wrap">
        <label className="grow">
          모델
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="비우면 기본" disabled={!alive || busy} />
        </label>
        <button className="ghost small" disabled={!alive || busy} onClick={() => run(() => api.setModel(name, model.trim() || null), '모델 바꿈')}>
          적용
        </button>
        <label className="grow">
          권한 모드
          <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)} disabled={!alive || busy}>
            {PERMISSION_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <button className="ghost small" disabled={!alive || busy} onClick={() => run(() => api.setMode(name, mode), '권한 모드 바꿈')}>
          적용
        </button>
      </div>
      <div className="muted small">다음 다시 시작 때도 그대로 유지돼요.</div>

      {alive && (
        <>
          <div className="section-title">
            컨텍스트 사용량
            <button className="ghost small" onClick={loadCtx}>
              새로고침
            </button>
          </div>
          {ctx ? (
            <div className="ctx">
              <div className="ctx-bar" title={`${ctx.totalTokens.toLocaleString()} / ${ctx.maxTokens.toLocaleString()} 토큰`}>
                {ctx.categories.map((c, i) =>
                  c.isDeferred || isFree(c.name) || c.tokens <= 0 ? null : (
                    <span key={c.name} style={{ width: `${(c.tokens / ctx.rawMaxTokens) * 100}%`, background: CTX_COLORS[i % CTX_COLORS.length] }} title={`${c.name}: ${c.tokens.toLocaleString()}`} />
                  ),
                )}
              </div>
              <div className="small">
                <b>{ctx.percentage.toFixed(1)}%</b> · {ctx.totalTokens.toLocaleString()} / {ctx.maxTokens.toLocaleString()} 토큰 · {ctx.model}
                {ctx.isAutoCompactEnabled ? ' · 자동 압축 켜짐' : ''}
              </div>
              <ul className="ctx-cats small">
                {ctx.categories.map((c, i) => (
                  <li key={c.name}>
                    <span className="swatch" style={{ background: c.isDeferred || isFree(c.name) ? 'var(--surface-3)' : CTX_COLORS[i % CTX_COLORS.length] }} /> {c.name} <span className="muted">{c.tokens.toLocaleString()}</span>
                    {c.isDeferred ? <span className="muted"> (지연 로드)</span> : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="muted small">불러오는 중…</div>
          )}
        </>
      )}

      <div className="section-title">옵션 바꿔서 다시 시작</div>
      <div className="muted small">MCP 서버 추가/제거, 추가 프롬프트, 스트리밍 등은 다시 시작해야 적용돼요. 바꾼 옵션은 저장돼서 다음에도 쓰여요.</div>
      <SdkOptionsFields value={form} onChange={setForm} redacted />
      <div className="row wrap">
        <button className="primary small" disabled={busy} onClick={() => restart(true)}>
          이어서 다시 시작
        </button>
        <button className="ghost small" disabled={busy} onClick={() => restart(false)}>
          새 대화로 다시 시작
        </button>
        <button className="ghost small" disabled={busy} onClick={() => setForm(formFromOptions(opts))}>
          되돌리기
        </button>
      </div>

      <details className="sv-info">
        <summary>저장된 옵션 (JSON, 비밀 값은 가림)</summary>
        <pre className="prompt mono small">{JSON.stringify(opts, null, 2)}</pre>
      </details>
    </div>
  );
}
