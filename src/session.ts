import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CARDINAL_HOME, ROOT, SESSIONS_DIR, WORKSPACE, hookDir, tmuxName, transcriptPath } from './paths.js';
import {
  listNames,
  readMeta,
  readState,
  removeSession,
  stateDir,
  writeMeta,
  writeState,
  type Role,
  type SessionMeta,
  type SessionState,
} from './store.js';
import { withLock } from './lock.js';
import * as tmux from './tmux.js';
import { lastTurn, readTurns, type Turn } from './transcript.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 생성 ----------

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

// 훅 폴더를 명령 인자로 박음 → 이 claude 프로세스의 훅은 평생 이 폴더만 씀
function hookSettings(dir: string) {
  const command = `${shq(process.execPath)} ${shq(path.join(ROOT, 'dist', 'hook.js'))} ${shq(dir)}`;
  return {
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((ev) => [
        ev,
        [{ matcher: TOOL_EVENTS.has(ev) ? '*' : undefined, hooks: [{ type: 'command', command, timeout: 10 }] }],
      ]),
    ),
  };
}

// Bash 도구는 사용자 셸 프로필로 PATH를 다시 잡아서 tmux -e PATH가 안 먹음 → 프롬프트에 절대경로 박음
const CLI = shq(path.join(ROOT, 'bin', 'cardinal'));

const COMMON_PROMPT = (name: string, role: Role) => `
너는 카디널(Cardinal)이 띄운 tmux-Claude Code 세션 "${name}" 이고 레벨은 ${role} 이다.
세션 제어 CLI는 ${CLI} 이다 (\`${CLI} help\` 참고). 아래에서 \`cardinal\` 은 이 경로를 뜻한다.

\`[cardinal:event <이벤트ID>]\` 로 시작하는 메시지는 외부 채널(디스코드 등)에서 온 이벤트다.
그 이벤트에 답할 때는 터미널에 쓰는 것만으로는 전달되지 않는다. 반드시 아래 도구로 보내라:
  \`cardinal reply <이벤트ID> "<답장 텍스트>" [--file <경로>]...\`
  - 긴 텍스트는 \`cardinal reply <이벤트ID> - <<'EOF' ... EOF\` 처럼 stdin으로
  - 이미지/파일은 --file 로 첨부 (최대 10개, 각 10MB). 이벤트 첨부파일은 메시지에 적힌 로컬 경로에 있다
`;

const MASTER_PROMPT = `
너는 마스터 세션이다. 작업을 나눌 때는 Claude Code 내장 서브 에이전트(Agent/Task 도구)나 워크플로 대신
\`cardinal new <이름> --prompt "<지시>" --wait\` 로 독립 워커 세션을 띄워서 맡겨라.
사용자가 서브 에이전트를 쓰라고 따로 요청한 경우에만 예외.
- 지시 추가: \`cardinal send <이름> "<메시지>" --wait\` (마지막 응답이 출력됨)
- 상태 확인: \`cardinal ls\`, \`cardinal status <이름>\`
- 결과 확인: \`cardinal report <이름>\` (살아있는지 + 작업중/완료 + 마지막 턴 응답 전체), \`cardinal screen <이름>\` (현재 화면)
- 승인 대기(waiting)면 \`cardinal screen\` 으로 보고 \`cardinal keys <이름> <키>\` 로 처리
- 정리: \`cardinal kill <이름>\`
`;

export interface CreateOptions {
  name: string;
  role?: Role;
  prompt?: string;
  claudeArgs?: string[];
}

const CREATE_LOCK_TIMEOUT_MS = 30_000;

// 같은 이름 생성은 이름별 락으로 한 번에 하나씩.
// 락 없이 "있나 확인 → 만들기" 를 하면 동시에 들어온 두 요청이 둘 다 확인을 통과해서
// meta.json 이 tmux 띄우기에 실패한 쪽 instanceId 를 가리킨 채 남음 (세션이 영원히 starting).
export async function createSession(opts: CreateOptions): Promise<SessionMeta> {
  const { name } = opts;
  if (!NAME_RE.test(name)) throw new Error(`세션 이름 규칙 위반: ${name} (영문/숫자/-/_ , 최대 48자)`);
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  return withLock(path.join(SESSIONS_DIR, `.create-${name}.lock`), CREATE_LOCK_TIMEOUT_MS, () => createLocked(opts));
}

// 지금 떠 있는 세션 목록에 같은 이름이 있으면 거부. 죽은 세션 기록만 남은 건 새로 만들어도 됨
async function assertNameFree(name: string): Promise<void> {
  const t = tmuxName(name);
  const existing = (await listStatus()).find((s) => s.name === name);
  if (existing?.alive) throw new Error(`이미 있는 세션: ${name} (${existing.state})`);
  // 카디널 기록 없이 같은 이름 tmux 세션만 떠 있는 경우도 막음
  if ((await tmux.listSessions()).includes(t)) throw new Error(`이미 있는 tmux 세션: ${t}`);
}

async function createLocked(opts: CreateOptions): Promise<SessionMeta> {
  const { name } = opts;
  const t = tmuxName(name);
  await assertNameFree(name);

  const role = opts.role ?? 'worker';
  // 전부 고정 작업 폴더에서 돌림. macOS /tmp → /private/tmp 같은 심링크는 claude가 실제 경로로 쓰니까 맞춰줌
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const cwd = fs.realpathSync(WORKSPACE);

  const instanceId = randomUUID();
  const hdir = hookDir(instanceId);
  const claudeSessionId = randomUUID();
  const claudeArgs = opts.claudeArgs ?? [];
  const systemPrompt = COMMON_PROMPT(name, role) + (role === 'master' ? MASTER_PROMPT : '');
  const argv = [
    'claude',
    '--session-id', claudeSessionId,
    '--name', name,
    '--settings', JSON.stringify(hookSettings(hdir)),
    '--append-system-prompt', systemPrompt,
    ...claudeArgs,
    ...(opts.prompt ? [opts.prompt] : []),
  ];

  const meta: SessionMeta = {
    name,
    instanceId,
    tmux: t,
    role,
    cwd,
    claudeSessionId,
    claudeArgs,
    createdAt: new Date().toISOString(),
  };
  // 이전에 같은 이름으로 죽은 세션 기록(이름 폴더 + 그 훅 폴더)이 남아 있으면 치우고 시작
  removeSession(name);
  fs.mkdirSync(hdir, { recursive: true });
  writeState(hdir, { state: 'starting', at: meta.createdAt, event: 'Create', claudeSessionId });
  writeMeta(meta);

  try {
    await tmux.tmux(
      'new-session', '-d',
      '-s', t,
      '-c', cwd,
      '-x', '200', '-y', '50',
      '-e', `CARDINAL_SESSION=${name}`,
      '-e', `CARDINAL_INSTANCE=${instanceId}`,
      '-e', `CARDINAL_ROLE=${role}`,
      '-e', `CARDINAL_HOME=${CARDINAL_HOME}`,
      '-e', `PATH=${path.join(ROOT, 'bin')}:${process.env.PATH ?? ''}`,
      '--', ...argv,
    );
  } catch (e: any) {
    // 안 뜬 인스턴스를 가리키는 meta/훅 폴더가 남지 않게 롤백
    removeSession(name);
    const reason = String(e?.stderr ?? '').trim() || e?.message?.split('\n')[0] || String(e);
    throw new Error(`tmux 세션 생성 실패: ${reason}`);
  }
  // 웹/터미널 여러 군데서 붙어도 가장 최근에 만진 클라이언트 크기 따라가게
  await tmux.setOption(t, 'window-size', 'latest').catch(() => {});

  return meta;
}

// ---------- 조회 ----------

export interface SessionStatus extends SessionMeta {
  currentClaudeSessionId: string; // /clear 뒤엔 meta.claudeSessionId 와 다름
  alive: boolean;
  state: SessionState;
  stateAt?: string;
  event?: string;
  detail?: string;
  tool?: string;
}

export async function getStatus(name: string): Promise<SessionStatus> {
  const meta = readMeta(name);
  if (!meta) throw new Error(`모르는 세션: ${name}`);
  const alive = await tmux.hasSession(meta.tmux);
  const s = readState(stateDir(meta));
  return {
    ...meta,
    currentClaudeSessionId: s?.claudeSessionId ?? meta.claudeSessionId,
    alive,
    // tmux가 죽었으면 훅이 못 찍었어도 ended로 봄
    state: alive ? (s?.state ?? 'starting') : 'ended',
    stateAt: s?.at,
    event: s?.event,
    detail: s?.detail,
    tool: s?.tool,
  };
}

export async function listStatus(): Promise<SessionStatus[]> {
  const all = await Promise.all(listNames().map((n) => getStatus(n).catch(() => undefined)));
  return all
    .filter((s): s is SessionStatus => !!s)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function screen(name: string, lines = 0, escapes = false): Promise<string> {
  const st = await getStatus(name);
  if (!st.alive) throw new Error(`세션 안 살아있음: ${name}`);
  return tmux.capturePane(st.tmux, lines, escapes);
}

export function transcriptFile(name: string): string | undefined {
  const meta = readMeta(name);
  if (!meta) return undefined;
  const s = readState(stateDir(meta));
  // 훅이 마지막으로 본 claude 세션 ID 기준 (/clear 하면 바뀜)
  const file = transcriptPath(meta.cwd, s?.claudeSessionId ?? meta.claudeSessionId);
  // 예전 방식(세션별 cwd)으로 만든 세션이면 훅이 적어둔 경로로
  return fs.existsSync(file) ? file : s?.transcriptPath;
}

// 마지막 턴에서 assistant가 쓴 텍스트 전부 (중간 보고 포함)
export function lastReply(name: string): string | undefined {
  const file = transcriptFile(name);
  const turn = file ? lastTurn(file) : undefined;
  return turn?.texts.length ? turn.texts.join('\n\n') : undefined;
}

// dead: tmux 없음 / starting: 준비 전 / working: 작업 중 / waiting: 승인 대기 / done: 턴 끝나고 입력 대기
export type Phase = 'dead' | 'starting' | 'working' | 'waiting' | 'done';

export interface Report {
  status: SessionStatus;
  phase: Phase;
  transcript?: string;
  turn?: Turn;
}

export async function report(name: string): Promise<Report> {
  const status = await getStatus(name);
  const phase: Phase = !status.alive
    ? 'dead'
    : status.state === 'busy'
      ? 'working'
      : status.state === 'idle'
        ? 'done'
        : status.state === 'ended'
          ? 'dead'
          : status.state;
  const transcript = transcriptFile(name);
  return { status, phase, transcript, turn: transcript ? lastTurn(transcript) : undefined };
}

// ---------- 제어 ----------

export interface SendOptions {
  submit?: boolean; // false면 입력창에 붙여넣기만
  force?: boolean; // waiting(권한 다이얼로그) 상태여도 보냄
  now?: boolean; // 작업 중이어도 안 기다리고 바로 넣음 (진행 중인 턴에 끼어듦)
  queueTimeoutMs?: number; // 락 + idle 대기 최대 시간 (기본 10분)
}

export interface SendResult {
  sentAt: number;
  accepted: boolean; // claude가 받았다는 훅 신호를 봤는지
  transcript?: string; // 보낼 때의 트랜스크립트
  turnIndex: number; // 이 메시지가 만들 턴의 위치 (보내기 직전 턴 개수)
}

const ACCEPT_TIMEOUT_MS = 10_000;

// 보낸 뒤 훅 상태가 sentAt 이후로 한 번이라도 바뀌면 claude가 입력을 받은 것
async function waitAccepted(name: string, sentAt: number): Promise<boolean> {
  const deadline = Date.now() + ACCEPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const st = await getStatus(name);
    if (!st.alive) return false;
    if (st.stateAt && Date.parse(st.stateAt) >= sentAt) return true;
    await sleep(50);
  }
  return false;
}

// 한 세션에 들어가는 send 는 세션 락으로 한 줄로 세움:
//  1. 락 잡기 (다른 send 가 붙여넣기~Enter 하는 중이면 기다림)
//  2. 작업 중이면 idle 될 때까지 기다림. 작업 중에 넣으면 진행 중인 턴에 끼어들어서
//     메시지 하나 = 턴 하나가 안 됨 (실측: busy 중 보낸 2개 → UserPromptSubmit 3번, Stop 1번)
//  3. 붙여넣기 → Enter → claude가 받았다는 신호까지 보고 락 풀기
export async function send(name: string, text: string, opts: SendOptions = {}): Promise<SendResult> {
  const meta = readMeta(name);
  if (!meta) throw new Error(`모르는 세션: ${name}`);
  const dir = stateDir(meta);
  const queueTimeoutMs = opts.queueTimeoutMs ?? 600_000;
  const deadline = Date.now() + queueTimeoutMs;

  return withLock(path.join(dir, 'send.lock'), queueTimeoutMs, async () => {
    let st = await getStatus(name);
    if (!st.alive) throw new Error(`세션 안 살아있음: ${name}`);
    if (!opts.now && (st.state === 'busy' || st.state === 'starting')) {
      st = await wait(name, { timeoutMs: Math.max(1, deadline - Date.now()) });
    }
    if (!st.alive || st.state === 'ended') throw new Error(`세션 안 살아있음: ${name}`);
    if (st.state === 'waiting' && !opts.force)
      throw new Error(`${name} 은(는) 승인 대기 중이라 메시지가 다이얼로그에 들어감. \`cardinal keys\`로 처리하거나 --force`);

    const transcript = transcriptFile(name);
    const turnIndex = transcript ? readTurns(transcript).length : 0;
    const sentAt = Date.now();
    await tmux.pasteText(st.tmux, text);
    if (opts.submit === false) return { sentAt, accepted: false, transcript, turnIndex };
    // 붙여넣기 직후 바로 Enter 치면 TUI가 가끔 삼킴
    await sleep(200);
    await tmux.sendKeys(st.tmux, 'Enter');
    const accepted = await waitAccepted(name, sentAt);
    return { sentAt, accepted, transcript, turnIndex };
  });
}

// send 가 만든 턴 (send 이후 첫 턴). 끝난 직후 다른 send 가 새 턴을 시작해도 남의 턴을 안 읽음
export function turnOf(name: string, res: SendResult): Turn | undefined {
  const file = transcriptFile(name);
  if (!file) return undefined;
  const turns = readTurns(file);
  // /clear 등으로 트랜스크립트가 바뀌었으면 위치를 못 믿으니 마지막 턴
  if (file !== res.transcript || turns.length <= res.turnIndex) return turns.at(-1);
  return turns[res.turnIndex];
}

export const turnText = (t?: Turn) => (t?.texts.length ? t.texts.join('\n\n') : undefined);

export async function keys(name: string, ...k: string[]): Promise<void> {
  const st = await getStatus(name);
  if (!st.alive) throw new Error(`세션 안 살아있음: ${name}`);
  await tmux.sendKeys(st.tmux, ...k);
}

export interface WaitOptions {
  since?: number; // 이 시각 이후에 찍힌 상태만 인정 (send 직후 대기용)
  timeoutMs?: number;
  until?: SessionState[];
  accept?: (st: SessionStatus) => boolean; // 추가 조건
}

// 세션이 손 놓을 때까지(idle/waiting/ended) 대기
export async function wait(name: string, opts: WaitOptions = {}): Promise<SessionStatus> {
  const until = opts.until ?? ['idle', 'waiting', 'ended'];
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
  for (;;) {
    const st = await getStatus(name);
    const fresh = !opts.since || (st.stateAt && Date.parse(st.stateAt) >= opts.since) || st.state === 'ended';
    if (fresh && until.includes(st.state) && (!opts.accept || opts.accept(st))) return st;
    if (Date.now() > deadline) throw Object.assign(new Error(`대기 시간 초과: ${name} (${st.state})`), { status: st });
    await sleep(500);
  }
}

export async function kill(name: string, purge = false): Promise<void> {
  const meta = readMeta(name);
  if (!meta) throw new Error(`모르는 세션: ${name}`);
  if (await tmux.hasSession(meta.tmux)) await tmux.killSession(meta.tmux);
  if (purge) return removeSession(name);
  const dir = stateDir(meta);
  if (fs.existsSync(dir)) writeState(dir, { ...(readState(dir) ?? {}), state: 'ended', at: new Date().toISOString(), event: 'Kill' });
}
