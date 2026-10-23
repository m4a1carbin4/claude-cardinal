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
  type SessionStateFile,
} from './store.js';
import { withLock } from './lock.js';
import * as tmux from './tmux.js';
import { interruptedAt, lastTurn, readTurns, type Turn } from './transcript.js';

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

// Bash 도구는 사용자 셸 프로필로 PATH를 다시 잡아서 세션에 넣어준 PATH가 안 먹음 → 프롬프트에 절대경로 박음
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
워커는 기본으로 너와 같은 작업 폴더에서 뜬다. 다른 폴더가 필요하면 \`--cwd <경로>\` (처음 쓰는 폴더면 \`--trust\` 도 같이).
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
  cwd?: string; // 세션 작업 폴더. 없으면 고정 워크스페이스. 훅/기록 위치(CARDINAL_HOME)와는 무관
  trust?: boolean; // 작업 폴더 신뢰 다이얼로그가 뜨면 자동으로 수락 (명시적으로 줄 때만)
}

// 처음 쓰는 폴더에서 claude 가 띄우는 "이 폴더를 신뢰하냐" 다이얼로그
const TRUST_PROMPT_RE = /trust this folder/i;
const TRUST_YES_SELECTED_RE = /❯\s*(?:\d\.\s*)?Yes, I trust/;
const TRUST_WAIT_MS = 20_000;

// 작업 폴더 결정. 기록을 지우기 전에 검사해야 잘못된 경로 때문에 이전 세션 기록이 날아가지 않음.
// claude 는 실제 경로(realpath)로 트랜스크립트 폴더를 만드니까 그걸로 기록 (macOS /tmp → /private/tmp 등)
function resolveCwd(cwd?: string): string {
  if (!cwd) {
    fs.mkdirSync(WORKSPACE, { recursive: true });
    return fs.realpathSync(WORKSPACE);
  }
  const abs = path.resolve(cwd);
  if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`작업 폴더가 없거나 디렉터리가 아님: ${abs}`);
  return fs.realpathSync(abs);
}

// tmux 가 기본 셸(-c)로 돌릴 명령 문자열. 인자마다 작은따옴표로 감쌈 (sh/bash/zsh/fish 공통)
const shellQuote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
const shellCommand = (argv: string[]) => argv.map((a, i) => (i < 2 ? a : shellQuote(a))).join(' ');

// 이 CLI 를 부른 게 카디널 세션 안(예: 마스터의 Bash 도구)이면 그 세션.
// 세션을 띄울 때 env 로 넣어준 CARDINAL_SESSION/INSTANCE 가 남아 있음. 같은 이름으로 다시 만들어진 세션과 헷갈리지 않게
// meta 의 instanceId 까지 맞아야 인정
function callerSession(): SessionMeta | undefined {
  const name = process.env.CARDINAL_SESSION;
  const instanceId = process.env.CARDINAL_INSTANCE;
  if (!name || !instanceId) return undefined;
  const meta = readMeta(name);
  return meta?.instanceId === instanceId ? meta : undefined;
}

// --trust: 신뢰 다이얼로그가 뜨면 "Yes, I trust this folder" 로 넘김. 안 뜨고 바로 준비되면 그냥 끝
async function acceptTrust(name: string, t: string): Promise<boolean> {
  const deadline = Date.now() + TRUST_WAIT_MS;
  while (Date.now() < deadline) {
    const st = await getStatus(name);
    if (!st.alive || st.state !== 'starting') return false;
    if (st.trustPrompt) {
      // 다이얼로그가 그려진 직후엔 키를 아직 안 받아서 Down 이 씹히고 Enter 만 먹으면 기본값 "No, exit" 로 claude 가 꺼짐.
      // 그래서 커서(❯)가 "Yes" 줄에 온 걸 화면으로 확인한 뒤에만 Enter
      const screen = await tmux.capturePane(t).catch(() => '');
      if (TRUST_YES_SELECTED_RE.test(screen)) {
        await tmux.sendKeys(t, 'Enter');
        return true;
      }
      await tmux.sendKeys(t, 'Down');
    }
    await sleep(300);
  }
  return false;
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
  // 작업 폴더: --cwd > 만든 세션(마스터)의 작업 폴더 > 고정 워크스페이스
  const parent = callerSession();
  const cwd = resolveCwd(opts.cwd ?? parent?.cwd);

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
    ...(parent ? { parent: { name: parent.name, instanceId: parent.instanceId! } } : {}),
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
      // 환경변수는 new-session -e 대신 env 로 넣음 (-e 는 tmux 3.2+ 에만 있음).
      // 명령도 셸 문자열 하나로: 인자 여러 개를 그대로 실행하는 건 tmux 3.0+ 라서
      shellCommand([
        'exec', 'env',
        `CARDINAL_SESSION=${name}`,
        `CARDINAL_INSTANCE=${instanceId}`,
        `CARDINAL_ROLE=${role}`,
        `CARDINAL_HOME=${CARDINAL_HOME}`,
        `PATH=${path.join(ROOT, 'bin')}:${process.env.PATH ?? ''}`,
        ...argv,
      ]),
    );
  } catch (e: any) {
    // 안 뜬 인스턴스를 가리키는 meta/훅 폴더가 남지 않게 롤백
    removeSession(name);
    const reason = String(e?.stderr ?? '').trim() || e?.message?.split('\n')[0] || String(e);
    throw new Error(`tmux 세션 생성 실패: ${reason}`);
  }
  // 웹/터미널 여러 군데서 붙어도 가장 최근에 만진 클라이언트 크기 따라가게
  await tmux.setOption(t, 'window-size', 'latest').catch(() => {});
  if (opts.trust) await acceptTrust(name, t);

  return meta;
}

// ---------- 조회 ----------

export interface SessionStatus extends SessionMeta {
  currentClaudeSessionId: string; // /clear 뒤엔 meta.claudeSessionId 와 다름
  alive: boolean;
  trustPrompt?: boolean; // starting 인데 신뢰 다이얼로그가 떠 있음 (사람이나 --trust 가 넘겨야 함)
  restoredInput?: boolean; // 응답 전 Esc 중단으로 프롬프트가 입력창에 되돌아왔을 수 있음
  state: SessionState;
  stateAt?: string;
  event?: string;
  detail?: string;
  tool?: string;
}

const INTERRUPTED_DETAIL = '사람이 중단함 (Esc)';

// Esc 로 중단하면 Stop 훅이 안 와서 상태가 busy 에 남음. 사람이 개입한 거니까 거기서 손 떼고 idle 로 봄.
// 트랜스크립트에 마지막 사람 입력 뒤로 "[Request interrupted by user]" 가 있으면 중단된 것.
// 알아낸 건 state.json 에도 적어서 서버 DB/웹 UI 도 같은 상태를 보게 함 (그 사이 훅이 새로 썼으면 안 덮음)
// 작업 중이면 Claude Code 화면 맨 아래 줄에 "esc to interrupt" 가 떠 있음 (좁은 창에선 "esc to…" 로 잘림)
const BUSY_HINT_RE = /esc to/i;
const SCREEN_CHECK_MIN_AGE_MS = 3_000;
const SCREEN_RECHECK_MS = 800;
// 이보다 좁으면 안내가 잘려서 안 보일 수 있어 화면 판정은 안 함 (잘못 판정할 바엔 건너뜀)
const SCREEN_CHECK_MIN_WIDTH = 60;

const footerShowsBusy = (screen: string) =>
  BUSY_HINT_RE.test(screen.split('\n').filter((l) => l.trim()).slice(-3).join('\n'));

// 응답이 나오기 전에 Esc 로 중단하면 트랜스크립트에 중단 표시가 안 남고 (실측) 프롬프트가 입력창으로 되돌아옴.
// 그래서 화면으로 판정: busy 가 3초 넘게 그대로인데 맨 아래에 작업 중 안내가 없고,
// 0.8초 뒤 다시 봐도 훅이 새로 안 찍혔고 여전히 없으면 중단된 것
async function screenSaysStopped(meta: SessionMeta, s: SessionStateFile): Promise<boolean> {
  if (s.state !== 'busy' || Date.now() - Date.parse(s.at) < SCREEN_CHECK_MIN_AGE_MS) return false;
  if ((await tmux.paneWidth(meta.tmux).catch(() => 0)) < SCREEN_CHECK_MIN_WIDTH) return false;
  const first = await tmux.capturePane(meta.tmux).catch(() => null);
  if (first === null || footerShowsBusy(first)) return false;
  await sleep(SCREEN_RECHECK_MS);
  if (readState(stateDir(meta))?.at !== s.at) return false; // 그 사이 훅이 찍음 (Stop 등) → 정상 종료
  const second = await tmux.capturePane(meta.tmux).catch(() => null);
  return second !== null && !footerShowsBusy(second);
}

async function applyInterrupt(meta: SessionMeta, s: SessionStateFile | undefined): Promise<SessionStateFile | undefined> {
  if (!s || (s.state !== 'busy' && s.state !== 'waiting')) return s;
  const file = transcriptFile(meta.name);
  const marked = file ? interruptedAt(file) : undefined;
  let next: SessionStateFile;
  if (marked && Date.parse(marked) >= Date.parse(s.at)) {
    next = { ...s, state: 'idle', at: marked, event: 'Interrupted', detail: INTERRUPTED_DETAIL, tool: undefined };
  } else if (await screenSaysStopped(meta, s)) {
    next = {
      ...s,
      state: 'idle',
      at: new Date().toISOString(),
      event: 'Interrupted',
      detail: `${INTERRUPTED_DETAIL}, 응답 전`,
      tool: undefined,
      restoredInput: true,
    };
  } else return s;
  const dir = stateDir(meta);
  try {
    if (readState(dir)?.at === s.at) writeState(dir, next);
  } catch {
    // 훅 폴더가 사라졌으면 그냥 보정값만 돌려줌
  }
  return next;
}

export async function getStatus(name: string): Promise<SessionStatus> {
  const meta = readMeta(name);
  if (!meta) throw new Error(`모르는 세션: ${name}`);
  const alive = await tmux.hasSession(meta.tmux);
  const s = alive ? await applyInterrupt(meta, readState(stateDir(meta))) : readState(stateDir(meta));
  // 아직 준비 전이면 신뢰 다이얼로그에 걸려 있는지 화면으로 확인 (starting 일 때만 봐서 비용 작음)
  const state = alive ? (s?.state ?? 'starting') : 'ended';
  const trustPrompt = state === 'starting' && TRUST_PROMPT_RE.test(await tmux.capturePane(meta.tmux).catch(() => ''));
  return {
    ...meta,
    currentClaudeSessionId: s?.claudeSessionId ?? meta.claudeSessionId,
    alive,
    // tmux가 죽었으면 훅이 못 찍었어도 ended로 봄
    state,
    trustPrompt: trustPrompt || undefined,
    restoredInput: s?.restoredInput || undefined,
    stateAt: s?.at,
    event: s?.event,
    detail: trustPrompt ? `작업 폴더 신뢰 다이얼로그 대기 (${meta.cwd}) — cardinal keys ${name} Down Enter` : s?.detail,
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
// interrupted: 사람이 Esc 로 중단함 (입력 대기지만 턴은 안 끝남)
export type Phase = 'dead' | 'starting' | 'working' | 'waiting' | 'done' | 'interrupted';

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
        ? status.event === 'Interrupted'
          ? 'interrupted'
          : 'done'
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

// Enter 한 번 누르고 받았다는 신호를 기다리는 시간, 그리고 Enter 를 몇 번까지 눌러볼지
const ACCEPT_WAIT_MS = 3_000;
const ENTER_ATTEMPTS = 3;
// SessionStart 훅 직후엔 claude 화면이 아직 입력을 못 받음. 이때 Enter 를 치면 먹혀서
// 텍스트가 입력창에 남은 채 멈춤 (실측: 세션 4개를 동시에 띄우고 바로 보냈을 때 재현)
const STARTUP_SETTLE_MS = 1_500;

// 보낸 뒤 훅 상태가 sentAt 이후로 한 번이라도 바뀌면 claude가 입력을 받은 것
async function waitAccepted(name: string, sentAt: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
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
  // tmux 가 한 번에 받는 크기 한도. 넘으면 tmux 가 거부하니까 락/대기 전에 미리 알려줌
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > tmux.PASTE_MAX_BYTES)
    throw new Error(
      `보낼 텍스트가 tmux 한 번 전달 한도를 넘음: ${bytes}바이트 > ${tmux.PASTE_MAX_BYTES}바이트 (tmux 제약). ` +
        `긴 내용은 파일로 저장하고 그 경로를 보내세요`,
    );
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
    // 신뢰 다이얼로그에 텍스트를 넣으면 다이얼로그 선택으로 먹힘. 600초 기다리지 말고 바로 알림
    if (st.trustPrompt) throw new Error(`${name}: ${st.detail}`);
    if (st.state === 'waiting' && !opts.force)
      throw new Error(`${name} 은(는) 승인 대기 중이라 메시지가 다이얼로그에 들어감. \`cardinal keys\`로 처리하거나 --force`);

    // 막 뜬 세션이면 화면이 입력을 받을 수 있게 될 때까지 조금 더
    if (st.event === 'SessionStart' && st.stateAt) {
      const age = Date.now() - Date.parse(st.stateAt);
      if (age < STARTUP_SETTLE_MS) await sleep(STARTUP_SETTLE_MS - age);
    }

    // 응답 전 Esc 로 중단된 뒤면 claude 가 그 프롬프트를 입력창에 되돌려 놓았을 수 있음.
    // 그대로 붙여넣으면 섞이니까 비우고 시작. C-u 는 한 줄만 지워서 BSpace 로 윗줄과 합치며 반복
    if (st.restoredInput) {
      await tmux.sendKeys(st.tmux, 'C-u', ...Array.from({ length: 40 }, () => ['BSpace', 'C-u']).flat());
      await sleep(150);
    }

    const transcript = transcriptFile(name);
    const turnIndex = transcript ? readTurns(transcript).length : 0;
    const sentAt = Date.now();
    await tmux.pasteText(st.tmux, text);
    if (opts.submit === false) return { sentAt, accepted: false, transcript, turnIndex };
    // 붙여넣기 직후 바로 Enter 치면 TUI가 가끔 삼킴
    await sleep(200);
    // Enter 가 먹히면 텍스트가 입력창에 남아 있으니 다시 누름.
    // 이미 받았는데 훅만 늦은 경우엔 빈 입력창에 Enter 라 아무 일도 안 일어남
    let accepted = false;
    for (let i = 0; i < ENTER_ATTEMPTS && !accepted; i++) {
      await tmux.sendKeys(st.tmux, 'Enter');
      accepted = await waitAccepted(name, sentAt, ACCEPT_WAIT_MS);
    }
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

const SETTLE_TIMEOUT_MS = 5_000;

// Stop 훅은 마지막 답 줄이 트랜스크립트 파일에 쓰이기 전에 옴 (실측: Stop 보다 80~130ms 늦게 파일에 나타남).
// Stop 직후 바로 읽으면 마지막 답을 놓치니까, 그 턴이 end_turn 으로 끝났다고 기록될 때까지 잠깐 더 기다림.
// waiting(승인 대기) 처럼 턴이 안 끝난 채 멈춘 경우는 기다려도 안 끝나니까 바로 지금까지의 걸 돌려줌.
export async function settledTurnOf(name: string, res: SendResult, st: SessionStatus): Promise<Turn | undefined> {
  // 사람이 중단한 턴은 기다려도 안 끝남
  if (st.state !== 'idle' || st.event === 'Interrupted') return turnOf(name, res);
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const t = turnOf(name, res);
    if (t?.complete || Date.now() > deadline) return t;
    await sleep(50);
  }
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
    // 신뢰 다이얼로그는 사람(또는 --trust)이 넘겨야 풀림. 기다려봐야 소용없으니 바로 돌려줌
    if (st.trustPrompt) return st;
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
