// 카디널 서버 API 클라이언트. 토큰은 URL ?token= 으로 한 번 받으면 이 브라우저에 기억해 둠
import type {
  AnswerInput,
  ChannelEvent,
  ContextUsage,
  DriveDir,
  DriveEntry,
  McpStatus,
  Pending,
  PermissionMode,
  SdkOptions,
  SdkTurnRow,
  Reply,
  CreateInput,
  Health,
  HookEvent,
  Report,
  Route,
  RouteInput,
  SendResult,
  Session,
} from './types';

const TOKEN_KEY = 'cardinal.token';

function readStored(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let token: string | null = (() => {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // 저장 안 돼도 이번 세션 동안은 씀
    }
    // 주소창에 토큰이 남지 않게 지움
    const url = new URL(location.href);
    url.searchParams.delete('token');
    history.replaceState(null, '', url);
    return fromUrl;
  }
  return readStored();
})();

export function setToken(t: string | null) {
  token = t || null;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 무시
  }
}

export const hasToken = () => !!token;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  // 멀티파트(FormData)는 브라우저가 경계값까지 넣어주니 content-type 을 직접 안 붙임
  if (init.body && typeof init.body === 'string') headers.set('content-type', 'application/json');
  const res = await fetch(`/api${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = (body as { detail?: unknown }).detail;
    throw new ApiError(res.status, typeof d === 'string' ? d : d ? JSON.stringify(d) : `HTTP ${res.status}`);
  }
  return body as T;
}

const enc = encodeURIComponent;
const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  health: () => req<Health>('/health'),
  sessions: (all = false) => req<Session[]>(`/sessions${all ? '?all=true' : ''}`),
  session: (name: string) => req<Session>(`/sessions/${enc(name)}`),
  create: (body: CreateInput) => req<Session>('/sessions', json(body)),
  kill: (name: string, purge = false) => req<{ ok: boolean }>(`/sessions/${enc(name)}${purge ? '?purge=true' : ''}`, { method: 'DELETE' }),
  send: (name: string, body: { text: string; attachments?: string[]; wait?: boolean; timeout_s?: number; submit?: boolean; now?: boolean; force?: boolean }) =>
    req<SendResult>(`/sessions/${enc(name)}/send`, json(body)),
  keys: (name: string, keys: string[]) => req<{ ok: boolean }>(`/sessions/${enc(name)}/keys`, json({ keys })),
  screen: (name: string, lines = 0) => req<{ screen: string }>(`/sessions/${enc(name)}/screen?lines=${lines}`),
  report: (name: string) => req<Report>(`/sessions/${enc(name)}/report`),
  events: (name: string, limit = 200) => req<HookEvent[]>(`/sessions/${enc(name)}/events?limit=${limit}`),
  // ---- SDK 세션 전용 ----
  interrupt: (name: string) => req<{ ok: boolean }>(`/sessions/${enc(name)}/interrupt`, { method: 'POST' }),
  restart: (name: string, body: { resume?: boolean; sdk?: Partial<SdkOptions> } = {}) =>
    req<Session>(`/sessions/${enc(name)}/restart`, json(body)),
  pending: (name: string) => req<Pending[]>(`/sessions/${enc(name)}/pending`),
  answer: (name: string, pid: string, body: AnswerInput) => req<unknown>(`/sessions/${enc(name)}/pending/${enc(pid)}`, json(body)),
  mcp: (name: string) => req<McpStatus>(`/sessions/${enc(name)}/mcp`),
  mcpAction: (name: string, server: string, action: 'reconnect' | 'enable' | 'disable') =>
    req<McpStatus>(`/sessions/${enc(name)}/mcp/${enc(server)}`, json({ action })),
  setModel: (name: string, model: string | null) => req<{ ok: boolean }>(`/sessions/${enc(name)}/model`, json({ model })),
  setMode: (name: string, mode: PermissionMode) => req<{ ok: boolean }>(`/sessions/${enc(name)}/permission-mode`, json({ mode })),
  context: (name: string) => req<ContextUsage>(`/sessions/${enc(name)}/context`),
  turns: (name: string, limit = 20) => req<SdkTurnRow[]>(`/sessions/${enc(name)}/turns?limit=${limit}`),
  routes: (name: string) => req<Route[]>(`/sessions/${enc(name)}/routes`),
  addRoute: (name: string, r: RouteInput) => req<Route>(`/sessions/${enc(name)}/routes`, json(r)),
  deleteRoute: (id: number) => req<{ ok: boolean }>(`/routes/${id}`, { method: 'DELETE' }),
  channelEvents: (limit = 50) => req<ChannelEvent[]>(`/events?limit=${limit}`),
  // 채널 이벤트에 직접 답장 (cardinal reply 와 같은 API). session 은 기록용 (어느 세션 이름으로 답했는지)
  reply: (eventId: string, text: string, files: File[], session?: string) => {
    const form = new FormData();
    form.set('text', text);
    form.set('session', session ?? '');
    for (const f of files) form.append('files', f, f.name);
    return req<Reply>(`/events/${enc(eventId)}/reply`, { method: 'POST', body: form });
  },
  inbound: (body: { content: string; channel: string; author: string; mentions_bot?: boolean }) =>
    req<ChannelEvent & { matched: string[] }>('/channel/inbound', json(body)),
  // ---- 웹드라이브 ----
  driveList: (path: string) => req<DriveDir>(`/drive?path=${enc(path)}`),
  driveReadText: (path: string) => req<DriveEntry & { content: string }>(`/drive/text?path=${enc(path)}`),
  driveWriteText: (path: string, content: string, overwrite = true) =>
    req<DriveEntry>('/drive/text', { method: 'PUT', body: JSON.stringify({ path, content, overwrite }) }),
  driveMkdir: (path: string) => req<DriveEntry>('/drive/mkdir', json({ path })),
  driveMove: (src: string, dst: string, overwrite = false) => req<DriveEntry>('/drive/move', json({ src, dst, overwrite })),
  driveDelete: (path: string, recursive = false) =>
    req<{ ok: boolean }>(`/drive?path=${enc(path)}${recursive ? '&recursive=true' : ''}`, { method: 'DELETE' }),
};

// 드라이브 파일 주소 (<a href>, <img> 용이라 토큰은 쿼리로)
export function driveFileUrl(path: string, download = false): string {
  const q = new URLSearchParams({ path });
  if (download) q.set('download', 'true');
  if (token) q.set('token', token);
  return `/api/drive/file?${q}`;
}

// 파일 올리기 + 진행률 (fetch 는 업로드 진행률을 못 줘서 XHR).
// to: 드라이브 폴더면 그 안에, {session} 이면 그 세션의 첨부 폴더(attachments/)에
export function uploadFiles(
  to: { dir: string } | { session: string },
  files: File[],
  onProgress?: (ratio: number) => void,
): Promise<DriveEntry[]> {
  const form = new FormData();
  if ('dir' in to) form.set('path', to.dir);
  for (const f of files) form.append('files', f, f.name);
  const url = 'dir' in to ? '/api/drive/upload' : `/api/sessions/${enc(to.session)}/attachments`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body: unknown = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // JSON 아님
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as DriveEntry[]);
      else {
        const d = (body as { detail?: unknown }).detail;
        reject(new ApiError(xhr.status, typeof d === 'string' ? d : `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, '업로드 실패 (연결)'));
    xhr.send(form);
  });
}

// 웹소켓 주소 (토큰은 쿼리로. 브라우저 웹소켓은 헤더를 못 붙임)
export function wsUrl(path: string, params: Record<string, string | number> = {}): string {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  if (token) q.set('token', token);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = q.toString();
  return `${proto}//${location.host}${path}${qs ? `?${qs}` : ''}`;
}

// tmux 한 번 전달 한도 (CLI src/tmux.ts PASTE_MAX_BYTES 와 같은 값)
export const PASTE_MAX_BYTES = 16_000;
export const byteLength = (s: string) => new TextEncoder().encode(s).length;

// 파일 → base64 (local 채널 첨부를 /ws/channel 로 넣을 때)
export async function fileToBase64(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// local 채널에 첨부파일까지 넣기. REST(inbound)는 첨부를 못 받아서 /ws/channel 메시지로 보냄
export function injectViaSocket(msg: {
  content: string;
  channel: string;
  author: string;
  mentions_bot: boolean;
  attachments: { filename: string; data: string }[];
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl('/ws/channel'));
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'message', ...msg }));
      // 서버가 받아서 처리할 시간을 조금 주고 닫음 (처리 결과는 /ws/channel 알림으로 옴)
      setTimeout(() => {
        ws.close();
        resolve();
      }, 500);
    };
    ws.onerror = () => reject(new Error('채널 웹소켓 연결 실패'));
  });
}
