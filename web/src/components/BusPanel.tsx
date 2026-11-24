import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { clock } from '../format';
import { useJsonSocket } from '../hooks';
import type { BusDelivery, BusKind, BusMessage, Session } from '../types';

const KIND: Record<BusKind, { label: string; tone: string; hint: string }> = {
  task: { label: '지시', tone: 'warn', hint: '일을 시킴 (결과를 기대)' },
  result: { label: '결과', tone: 'ok', hint: '일의 결과 보고' },
  info: { label: '알림', tone: 'info', hint: '알림 (답 필요 없음)' },
};
const LONG = 400; // 이보다 길면 접어서 보여 줌
const STATUS = { pending: '대기', sent: '전달', failed: '실패' } as const;

type Chip = { name: string; status: BusDelivery['status']; error: string | null };

// 받는 세션마다 전달 상태. 전달 기록이 아직 없으면(방금 보냄) 대기
function chips(m: BusMessage): Chip[] {
  return m.to_names.map((name) => {
    const d = m.deliveries.find((x) => x.session_name === name);
    return { name, status: d?.status ?? 'pending', error: d?.error ?? null };
  });
}

const involves = (m: BusMessage, session: string) => m.from_name === session || m.to_names.includes(session);

export function BusPanel({ sessions }: { sessions: Session[] }) {
  const [msgs, setMsgs] = useState<BusMessage[]>([]);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(100);
  const [session, setSession] = useState('');
  const [thread, setThread] = useState('');
  const [group, setGroup] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(
    () =>
      api.bus(limit, session || undefined, thread || undefined).then(
        (r) => {
          setMsgs(r);
          setError('');
        },
        (e) => setError((e as Error).message),
      ),
    [limit, session, thread],
  );
  useEffect(() => {
    load();
  }, [load]);

  // 실시간: 새 메시지는 앞에 붙이고, 전달 결과는 해당 메시지에 반영. 필터에 안 맞는 건 거름
  const live = useJsonSocket('/ws/channel', (m) => {
    if (m.type === 'bus' && m.message) {
      const msg: BusMessage = { ...m.message, deliveries: m.message.deliveries ?? [] };
      if ((session && !involves(msg, session)) || (thread && msg.thread !== thread)) return;
      setMsgs((prev) => (prev.some((x) => x.id === msg.id) ? prev : [msg, ...prev].slice(0, limit)));
    } else if (m.type === 'bus_delivery') {
      setMsgs((prev) =>
        prev.map((x) => {
          if (x.id !== m.msg_id) return x;
          const d: BusDelivery = { id: 0, msg_id: m.msg_id, session_id: '', session_name: m.session, status: m.status, error: m.error ?? null, at: new Date().toISOString() };
          return { ...x, deliveries: [...x.deliveries.filter((y) => y.session_name !== m.session), d] };
        }),
      );
    }
  });
  // 끊겼다 다시 붙으면 그사이 놓친 것 다시 불러오기
  useEffect(() => {
    if (live) load();
  }, [live, load]);

  const names = useMemo(() => {
    const set = new Set(sessions.filter((s) => !s.deleted_at).map((s) => s.name));
    for (const m of msgs) {
      set.add(m.from_name);
      m.to_names.forEach((n) => set.add(n));
    }
    return [...set].sort();
  }, [sessions, msgs]);

  const stats = useMemo(() => {
    let pending = 0;
    let failed = 0;
    for (const m of msgs) {
      for (const c of chips(m)) {
        if (c.status === 'pending') pending++;
        else if (c.status === 'failed') failed++;
      }
    }
    return { pending, failed };
  }, [msgs]);

  // 스레드로 묶기: 최근에 움직인 스레드부터, 안에선 오래된 것부터
  const groups = useMemo(() => {
    if (!group) return null;
    const map = new Map<string, BusMessage[]>();
    for (const m of msgs) map.set(m.thread, [...(map.get(m.thread) ?? []), m]);
    return [...map.entries()].map(([id, list]) => ({ id, list: [...list].reverse() }));
  }, [group, msgs]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  function row(m: BusMessage) {
    const k = KIND[m.kind] ?? KIND.info;
    const long = m.text.length > LONG;
    const expanded = open.has(m.id);
    return (
      <li key={m.id} className={`ev bus-msg kind-${m.kind}`}>
        <div className="ev-head">
          <span className={`badge ${k.tone}`} title={k.hint}>
            {k.label}
          </span>
          <button className="badge as-link bus-who" onClick={() => setSession(m.from_name)} title="이 세션이 보내거나 받은 것만 보기">
            {m.from_name}
          </button>
          <span className="muted small">→</span>
          {m.broadcast && <span className="badge muted">방송</span>}
          {m.to_names.map((n) => (
            <button key={n} className="badge as-link bus-who" onClick={() => setSession(n)} title="이 세션이 보내거나 받은 것만 보기">
              {n}
            </button>
          ))}
          <span className="spacer" />
          <button className="linklike small" onClick={() => setThread(m.thread)} title="이 스레드만 보기">
            <code>{m.id}</code>
          </button>
          <span className="muted small mono">{clock(m.at)}</span>
        </div>
        {m.reply_to && (
          <div className="muted small">
            ↩ <code>{m.reply_to}</code> 에 대한 {m.kind === 'result' ? '결과' : '답'}
            {m.depth > 0 && ` · ${m.depth}단계`}
          </div>
        )}
        <div className={`ev-content bus-text ${long && !expanded ? 'clamp' : ''}`}>{m.text}</div>
        {long && (
          <button className="linklike small" onClick={() => toggle(m.id)}>
            {expanded ? '접기' : `더 보기 (${m.text.length}자)`}
          </button>
        )}
        <div className="ev-flow">
          {chips(m).map((c) => (
            <span key={c.name} className={`badge ${c.status === 'sent' ? 'ok' : c.status === 'failed' ? 'err' : 'warn'}`} title={c.error ?? ''}>
              → {c.name} · {STATUS[c.status]}
              {c.error ? ` (${c.error})` : ''}
            </span>
          ))}
        </div>
      </li>
    );
  }

  return (
    <div className="channel-panel bus-panel">
      <div className="cp-head">
        <h2>세션 채널</h2>
        <span className={`dot ${live ? 'ok' : 'muted'}`} title={live ? '실시간 연결됨' : '연결 끊김'} />
        <span className="muted small">세션끼리 주고받는 기본 채널 · 지시 → 전달 → 결과</span>
        <span className="spacer" />
        <label className="check small">
          세션
          <select value={session} onChange={(e) => setSession(e.target.value)}>
            <option value="">전체</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="check small" title="같은 스레드(답장으로 이어진 것)끼리 묶어서">
          <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} /> 스레드로 묶기
        </label>
        <label className="check small">
          개수
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button className="ghost small" onClick={load}>
          새로고침
        </button>
      </div>

      <div className="row wrap small muted">
        <span>{msgs.length}개</span>
        {stats.pending > 0 && <span className="badge warn">대기 {stats.pending}</span>}
        {stats.failed > 0 && <span className="badge err">실패 {stats.failed}</span>}
        {session && (
          <button className="badge as-link" onClick={() => setSession('')}>
            세션: {session} ✕
          </button>
        )}
        {thread && (
          <button className="badge as-link" onClick={() => setThread('')}>
            스레드: {thread} ✕
          </button>
        )}
      </div>

      {error && <div className="alert err">{error}</div>}
      {msgs.length === 0 && !error && <div className="empty small">아직 주고받은 세션 채널 메시지 없음 (세션이 channel_post 로 보내면 여기 보임)</div>}
      {groups ? (
        groups.map((g) => (
          <section key={g.id} className="bus-thread">
            <div className="bus-thread-head muted small">
              스레드 <code>{g.id}</code> · {g.list.length}개
              {!thread && (
                <button className="linklike small" onClick={() => setThread(g.id)}>
                  이 스레드만
                </button>
              )}
            </div>
            <ul className="events">{g.list.map(row)}</ul>
          </section>
        ))
      ) : (
        <ul className="events">{msgs.map(row)}</ul>
      )}
    </div>
  );
}
