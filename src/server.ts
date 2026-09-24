import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as pty from 'node-pty';
import { WebSocketServer, type WebSocket } from 'ws';
import { ROOT, SESSIONS_DIR } from './paths.js';
import * as session from './session.js';
import { readMeta } from './store.js';

export interface ServeOptions {
  host: string;
  port: number;
  token?: string; // 있으면 모든 요청에 ?token= 또는 Authorization: Bearer 필요
}

class HttpError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

function authorized(req: http.IncomingMessage, url: URL, token?: string): boolean {
  if (!token) return true;
  return url.searchParams.get('token') === token || req.headers.authorization === `Bearer ${token}`;
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'JSON 파싱 실패');
  }
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// ---------- REST ----------

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // 'api' 떼기
  const method = req.method ?? 'GET';

  if (parts[0] !== 'sessions') throw new HttpError(404, 'not found');
  const name = parts[1] ? decodeURIComponent(parts[1]) : undefined;
  const action = parts[2];

  if (!name) {
    if (method === 'GET') return json(res, 200, await session.listStatus());
    if (method === 'POST') {
      const b = await readBody(req);
      await session.createSession({ name: b.name, role: b.role, prompt: b.prompt, claudeArgs: b.args });
      return json(res, 201, await session.getStatus(b.name));
    }
  } else if (!action) {
    if (method === 'GET') return json(res, 200, await session.getStatus(name));
    if (method === 'DELETE') {
      await session.kill(name, url.searchParams.get('purge') === '1');
      return json(res, 200, { ok: true });
    }
  } else if (action === 'send' && method === 'POST') {
    const b = await readBody(req);
    const sentAt = await session.send(name, String(b.text ?? ''), { submit: b.submit, force: b.force });
    if (b.wait) {
      const st = await session.wait(name, { since: sentAt, timeoutMs: b.timeoutMs });
      return json(res, 200, { status: st, last: session.lastReply(name) });
    }
    return json(res, 200, { ok: true, sentAt });
  } else if (action === 'keys' && method === 'POST') {
    const b = await readBody(req);
    await session.keys(name, ...(b.keys ?? []));
    return json(res, 200, { ok: true });
  } else if (action === 'screen' && method === 'GET') {
    const lines = Number(url.searchParams.get('lines') ?? 0);
    return json(res, 200, { screen: await session.screen(name, lines) });
  } else if (action === 'last' && method === 'GET') {
    return json(res, 200, { text: session.lastReply(name) ?? null });
  } else if (action === 'report' && method === 'GET') {
    return json(res, 200, await session.report(name));
  }
  throw new HttpError(404, 'not found');
}

// ---------- WebSocket: 터미널 ----------
// client → server: 텍스트 프레임 JSON  {t:'i', d:'입력'} | {t:'r', c:cols, r:rows}
// server → client: 바이너리 프레임 = 터미널 raw 출력

function attachTerminal(ws: WebSocket, name: string, url: URL) {
  const meta = readMeta(name);
  if (!meta) return ws.close(4404, 'unknown session');
  const cols = Number(url.searchParams.get('cols') ?? 120);
  const rows = Number(url.searchParams.get('rows') ?? 40);
  // readonly=1 이면 창 크기에 영향 안 주고 입력도 안 받는 관전 모드
  const readonly = url.searchParams.get('readonly') === '1';

  const args = ['attach-session', '-t', `=${meta.tmux}`];
  if (readonly) args.push('-r', '-f', 'ignore-size');
  const term = pty.spawn('tmux', args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: meta.cwd,
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  });

  term.onData((d) => ws.readyState === ws.OPEN && ws.send(Buffer.from(d, 'utf8')));
  term.onExit(() => ws.readyState === ws.OPEN && ws.close(1000, 'detached'));

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'i' && !readonly && typeof msg.d === 'string') term.write(msg.d);
    else if (msg.t === 'r' && msg.c > 0 && msg.r > 0) term.resize(msg.c, msg.r);
  });
  ws.on('close', () => term.kill());
}

// ---------- WebSocket: 상태 이벤트 ----------
// 접속하면 전체 목록 한 번, 이후 상태 파일 바뀔 때마다 {type:'sessions', sessions:[...]} 푸시

function createEventHub() {
  const clients = new Set<WebSocket>();
  let timer: NodeJS.Timeout | undefined;
  let lastPayload = '';

  const broadcast = async (force = false) => {
    const payload = JSON.stringify({ type: 'sessions', sessions: await session.listStatus() });
    if (!force && payload === lastPayload) return;
    lastPayload = payload;
    for (const c of clients) if (c.readyState === c.OPEN) c.send(payload);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void broadcast(), 150);
  };

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.watch(SESSIONS_DIR, { recursive: true }, schedule);
  // tmux 세션이 밖에서 죽는 건 파일 변화가 없으니 주기적으로도 확인
  setInterval(schedule, 3000).unref();

  return {
    add(ws: WebSocket) {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      void session.listStatus().then((sessions) => ws.send(JSON.stringify({ type: 'sessions', sessions })));
    },
  };
}

// ---------- 서버 ----------

export function serve(opts: ServeOptions) {
  const indexHtml = path.join(ROOT, 'public', 'index.html');
  const hub = createEventHub();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (!authorized(req, url, opts.token)) throw new HttpError(401, 'unauthorized');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return fs.createReadStream(indexHtml).pipe(res);
      }
      throw new HttpError(404, 'not found');
    } catch (err: any) {
      const code = err instanceof HttpError ? err.code : 400;
      json(res, code, { error: err?.message ?? String(err) });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!authorized(req, url, opts.token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const term = url.pathname.match(/^\/ws\/term\/([^/]+)$/);
    const isEvents = url.pathname === '/ws/events';
    if (!term && !isEvents) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (term) attachTerminal(ws, decodeURIComponent(term[1]), url);
      else hub.add(ws);
    });
  });

  server.listen(opts.port, opts.host, () => {
    console.log(`cardinal server: http://${opts.host}:${opts.port}${opts.token ? '/?token=***' : ''}`);
  });
  return server;
}
