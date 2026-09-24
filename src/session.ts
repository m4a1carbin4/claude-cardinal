import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CARDINAL_HOME, ROOT, WORKSPACE, tmuxName, transcriptPath } from './paths.js';
import {
  listNames,
  readMeta,
  readState,
  removeSessionDir,
  writeMeta,
  writeState,
  type Role,
  type SessionMeta,
  type SessionState,
} from './store.js';
import * as tmux from './tmux.js';
import { lastTurn, type Turn } from './transcript.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 생성 ----------

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

function hookSettings() {
  const command = `${shq(process.execPath)} ${shq(path.join(ROOT, 'dist', 'hook.js'))}`;
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

export async function createSession(opts: CreateOptions): Promise<SessionMeta> {
  const { name } = opts;
  if (!NAME_RE.test(name)) throw new Error(`세션 이름 규칙 위반: ${name} (영문/숫자/-/_ , 최대 48자)`);
  const t = tmuxName(name);
  if (await tmux.hasSession(t)) throw new Error(`이미 있는 세션: ${name}`);

  const role = opts.role ?? 'worker';
  // 전부 고정 작업 폴더에서 돌림. macOS /tmp → /private/tmp 같은 심링크는 claude가 실제 경로로 쓰니까 맞춰줌
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const cwd = fs.realpathSync(WORKSPACE);

  const claudeSessionId = randomUUID();
  const claudeArgs = opts.claudeArgs ?? [];
  const systemPrompt = COMMON_PROMPT(name, role) + (role === 'master' ? MASTER_PROMPT : '');
  const argv = [
    'claude',
    '--session-id', claudeSessionId,
    '--name', name,
    '--settings', JSON.stringify(hookSettings()),
    '--append-system-prompt', systemPrompt,
    ...claudeArgs,
    ...(opts.prompt ? [opts.prompt] : []),
  ];

  const meta: SessionMeta = {
    name,
    tmux: t,
    role,
    cwd,
    claudeSessionId,
    claudeArgs,
    createdAt: new Date().toISOString(),
  };
  // 이전에 같은 이름으로 죽은 세션 기록이 남아 있으면 치우고 시작
  removeSessionDir(name);
  writeMeta(meta);
  writeState(name, { state: 'starting', at: meta.createdAt, event: 'Create' });

  await tmux.tmux(
    'new-session', '-d',
    '-s', t,
    '-c', cwd,
    '-x', '200', '-y', '50',
    '-e', `CARDINAL_SESSION=${name}`,
    '-e', `CARDINAL_ROLE=${role}`,
    '-e', `CARDINAL_HOME=${CARDINAL_HOME}`,
    '-e', `PATH=${path.join(ROOT, 'bin')}:${process.env.PATH ?? ''}`,
    '--', ...argv,
  );
  // 웹/터미널 여러 군데서 붙어도 가장 최근에 만진 클라이언트 크기 따라가게
  await tmux.setOption(t, 'window-size', 'latest').catch(() => {});

  return meta;
}

// ---------- 조회 ----------

export interface SessionStatus extends SessionMeta {
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
  const s = readState(name);
  return {
    ...meta,
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
  const file = transcriptPath(meta.cwd, meta.claudeSessionId);
  // 예전 방식(세션별 cwd)으로 만든 세션이면 훅이 적어둔 경로로
  return fs.existsSync(file) ? file : readState(name)?.transcriptPath;
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
}

export async function send(name: string, text: string, opts: SendOptions = {}): Promise<number> {
  const st = await getStatus(name);
  if (!st.alive) throw new Error(`세션 안 살아있음: ${name}`);
  if (st.state === 'waiting' && !opts.force)
    throw new Error(`${name} 은(는) 승인 대기 중이라 메시지가 다이얼로그에 들어감. \`cardinal keys\`로 처리하거나 --force`);

  const sentAt = Date.now();
  await tmux.pasteText(st.tmux, text);
  if (opts.submit !== false) {
    // 붙여넣기 직후 바로 Enter 치면 TUI가 가끔 삼킴
    await sleep(200);
    await tmux.sendKeys(st.tmux, 'Enter');
  }
  return sentAt;
}

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
  if (purge) removeSessionDir(name);
  else writeState(name, { ...(readState(name) ?? {}), state: 'ended', at: new Date().toISOString(), event: 'Kill' });
}
