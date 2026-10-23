import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fileToBase64, injectViaSocket } from '../api';
import { clock } from '../format';
import { useJsonSocket } from '../hooks';
import type { ChannelEvent, Session } from '../types';

// local 채널 답장의 첨부파일 본문은 DB 에 없고 /ws/channel 의 reply 알림으로만 옴 → 받은 것만 내려받기 링크로
interface LocalFile {
  filename: string;
  content_type: string | null;
  data: string; // base64
}

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function checkFiles(files: File[]): string | null {
  if (files.length > MAX_FILES) return `첨부는 최대 ${MAX_FILES}개`;
  const big = files.find((f) => f.size > MAX_FILE_BYTES);
  return big ? `파일이 너무 큼 (> 10MB): ${big.name}` : null;
}

function downloadHref(f: LocalFile) {
  return `data:${f.content_type || 'application/octet-stream'};base64,${f.data}`;
}

// 이벤트 하나에 직접 답장 (cardinal reply 와 같은 API)
function ReplyForm({ ev, sessions, onDone }: { ev: ChannelEvent; sessions: Session[]; onDone: () => void }) {
  const delivered = ev.deliveries.map((d) => d.session_name);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [session, setSession] = useState(delivered[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const names = [...new Set([...delivered, ...sessions.filter((s) => !s.deleted_at).map((s) => s.name)])];

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const err = checkFiles(files);
    if (err) return setError(err);
    if (!text.trim() && !files.length) return setError('보낼 텍스트나 파일이 필요');
    setBusy(true);
    setError('');
    try {
      await api.reply(ev.id, text, files, session || undefined);
      setText('');
      setFiles([]);
      if (fileInput.current) fileInput.current.value = '';
      onDone();
    } catch (er) {
      setError((er as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="reply-form" onSubmit={send}>
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={`${ev.id} 에 답장 (원래 메시지에 답장으로 감)`} aria-label="답장 내용" />
      <div className="row wrap">
        <input ref={fileInput} type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} aria-label="답장 첨부파일" />
        <label className="check small" title="기록에 남길 보낸 세션 (자동 답장 중복 방지에도 씀)">
          보낸 세션
          <select value={session} onChange={(e) => setSession(e.target.value)}>
            <option value="">(없음 — 사람이 직접)</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <button className="primary small" disabled={busy}>
          {busy ? '보내는 중…' : '답장 보내기'}
        </button>
      </div>
      {error && <div className="alert err">{error}</div>}
    </form>
  );
}

export function ChannelPanel({ sessions }: { sessions: Session[] }) {
  const [events, setEvents] = useState<ChannelEvent[]>([]);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(50);
  const [channel, setChannel] = useState('local');
  const [author, setAuthor] = useState('web');
  const [content, setContent] = useState('');
  const [mention, setMention] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [lastMatch, setLastMatch] = useState<string[] | null>(null);
  const [replying, setReplying] = useState<string | null>(null);
  const [localFiles, setLocalFiles] = useState<Record<string, LocalFile[]>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api.channelEvents(limit).then(setEvents, (e) => setError((e as Error).message)), [limit]);
  useEffect(() => {
    load();
  }, [load]);
  const live = useJsonSocket('/ws/channel', (m) => {
    if (m.type === 'reply' && Array.isArray(m.files) && m.files.length) {
      setLocalFiles((prev) => ({ ...prev, [m.event_id]: [...(prev[m.event_id] ?? []), ...m.files] }));
    }
    load();
  });

  async function inject(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    const err = checkFiles(files);
    if (err) return setError(err);
    setError('');
    try {
      if (files.length) {
        // REST 는 첨부를 못 받아서 웹소켓으로. 매칭 결과는 이벤트 목록에서 확인
        const attachments = await Promise.all(files.map(async (f) => ({ filename: f.name, data: await fileToBase64(f) })));
        await injectViaSocket({ content, channel, author, mentions_bot: mention, attachments });
        setLastMatch(null);
      } else {
        const r = await api.inbound({ content, channel, author, mentions_bot: mention });
        setLastMatch(r.matched);
      }
      setContent('');
      setFiles([]);
      if (fileInput.current) fileInput.current.value = '';
      load();
    } catch (er) {
      setError((er as Error).message);
    }
  }

  return (
    <div className="channel-panel">
      <div className="cp-head">
        <h2>채널</h2>
        <span className={`dot ${live ? 'ok' : 'muted'}`} title={live ? '실시간 연결됨' : '연결 끊김'} />
        <span className="muted small">이벤트 → 세션 전달 → 답장</span>
        <span className="spacer" />
        <label className="check small">
          개수
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[20, 50, 200, 500].map((n) => (
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

      <form className="inject" onSubmit={inject}>
        <div className="muted small">local 채널로 메시지 넣기 (디스코드 없이 라우트 시험)</div>
        <div className="row wrap">
          <input className="w-sm" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="채널" aria-label="채널" />
          <input className="w-sm" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="작성자" aria-label="작성자" />
          <input className="grow" value={content} onChange={(e) => setContent(e.target.value)} placeholder="예: !ask 안녕" aria-label="내용" />
        </div>
        <div className="row wrap">
          <label className="check small" title="멘션(@봇) 라우트에 맞게 봇이 멘션된 메시지로 넣음">
            <input type="checkbox" checked={mention} onChange={(e) => setMention(e.target.checked)} /> 봇 멘션
          </label>
          <input ref={fileInput} type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} aria-label="첨부파일" />
          <span className="spacer" />
          <button className="primary small" disabled={!content.trim()}>
            넣기
          </button>
        </div>
        {lastMatch && <div className="small muted">매칭된 세션: {lastMatch.length ? lastMatch.join(', ') : '없음 (라우트 조건 확인)'}</div>}
      </form>

      {error && <div className="alert err">{error}</div>}
      {events.length === 0 && <div className="empty small">아직 받은 채널 이벤트 없음</div>}
      <ul className="events">
        {events.map((ev) => (
          <li key={ev.id} className="ev">
            <div className="ev-head">
              <span className="badge">{ev.platform}</span>
              <span className="muted small">#{ev.channel_name ?? ev.channel_id}</span>
              {ev.guild && <span className="muted small">({ev.guild})</span>}
              <span className="muted small">· {ev.author ?? '?'}</span>
              <span className="spacer" />
              <code className="small">{ev.id}</code>
              <span className="muted small mono">{clock(ev.received_at)}</span>
            </div>
            <div className="ev-content">{ev.content}</div>
            {ev.attachments.length > 0 && (
              <div className="file-list">
                {ev.attachments.map((a, i) => (
                  <span key={i} className="file-chip" title={a.local_path ?? a.url ?? ''}>
                    📎 {a.filename}
                    {a.size ? ` · ${Math.ceil(a.size / 1024)}KB` : ''}
                    {a.error ? ` · 저장 실패: ${a.error}` : ''}
                  </span>
                ))}
              </div>
            )}
            <div className="ev-flow">
              {ev.deliveries.length === 0 && <span className="muted small">매칭된 세션 없음</span>}
              {ev.deliveries.map((d) => (
                <span key={d.id} className={`badge ${d.status === 'sent' ? 'ok' : d.status === 'failed' ? 'err' : 'warn'}`} title={d.error ?? ''}>
                  → {d.session_name} · {d.status === 'pending' ? '대기' : d.status === 'sent' ? '전달' : '실패'}
                  {d.error ? ` (${d.error})` : ''}
                </span>
              ))}
            </div>
            {ev.replies.map((r) => (
              <div key={r.id} className={`ev-reply ${r.status === 'failed' ? 'failed' : ''}`}>
                <span className="badge">{r.source === 'auto' ? '자동 답장' : '답장'}</span>
                {r.status === 'failed' && <span className="badge err">실패: {r.error}</span>}
                <span className="reply-text">{r.text}</span>
                {r.files.length > 0 && <span className="muted small"> 📎 {r.files.map((f) => f.filename).join(', ')}</span>}
              </div>
            ))}
            {(localFiles[ev.id] ?? []).length > 0 && (
              <div className="file-list">
                <span className="muted small">local 답장 첨부:</span>
                {localFiles[ev.id].map((f, i) => (
                  <a key={i} className="dl" href={downloadHref(f)} download={f.filename}>
                    ⬇ {f.filename}
                  </a>
                ))}
              </div>
            )}
            <div className="row">
              <button className="ghost small" onClick={() => setReplying(replying === ev.id ? null : ev.id)}>
                {replying === ev.id ? '답장 닫기' : '직접 답장'}
              </button>
            </div>
            {replying === ev.id && (
              <ReplyForm
                ev={ev}
                sessions={sessions}
                onDone={() => {
                  setReplying(null);
                  load();
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
