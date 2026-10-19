// Claude Code 훅으로 불리는 스크립트. stdin으로 훅 이벤트 JSON 받아서 상태 파일 갱신.
// 주의: stdout에 뭐 찍으면 SessionStart/UserPromptSubmit 같은 건 컨텍스트에 들어가버림 → 절대 출력 금지.
//
// 사용법: node hook.js <훅 폴더>
// 훅 폴더는 세션 띄울 때 --settings 의 훅 명령에 박혀서 들어옴 (세션 인스턴스마다 하나).
// 훅은 이 폴더만 쓰고 세션 이름은 모름. 그래서
//  - /clear 해도 같은 claude 프로세스라 같은 폴더
//  - 같은 이름으로 새로 만들어도 이전 프로세스의 늦은 훅은 자기 옛 폴더로만 감
//  - 폴더가 지워졌으면(purge) 아무것도 안 쓰고 끝
import fs from 'node:fs';
import { sessionDir } from './paths.js';
import { appendEvent, readState, writeState, type SessionState } from './store.js';

interface HookInput {
  hook_event_name: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  message?: string;
  notification_type?: string;
  source?: string;
  reason?: string;
  tool_input?: unknown;
  prompt_id?: string;
}

const clip = (s: string | undefined, n = 200) =>
  s === undefined ? undefined : s.length > n ? s.slice(0, n) + '…' : s;

// 이벤트 → 상태. undefined면 상태는 그대로 두고 로그만 남김
function nextState(e: HookInput): SessionState | undefined {
  switch (e.hook_event_name) {
    case 'SessionStart':
    case 'Stop':
      return 'idle';
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'busy';
    case 'Notification': {
      // idle_prompt = "입력 기다리는 중" 알림이라 waiting 아님
      if (e.notification_type === 'idle_prompt') return 'idle';
      if (e.notification_type) return 'waiting';
      return /waiting for your input/i.test(e.message ?? '') ? 'idle' : 'waiting';
    }
    case 'SessionEnd':
      return 'ended';
    default:
      return undefined;
  }
}

// 인자 없이 불리면 예전 방식 세션 (이름 폴더를 같이 씀)
function resolveDir(): string | undefined {
  if (process.argv[2]) return process.argv[2];
  const name = process.env.CARDINAL_SESSION;
  return name ? sessionDir(name) : undefined;
}

async function main() {
  const dir = resolveDir();
  if (!dir || !fs.existsSync(dir)) return; // 카디널 세션 아님, 또는 이미 지워진 세션

  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const e = JSON.parse(raw) as HookInput;
  const at = new Date().toISOString();

  appendEvent(dir, {
    at,
    event: e.hook_event_name,
    tool: e.tool_name,
    prompt: clip(e.prompt, 2000),
    message: e.message,
    notificationType: e.notification_type,
    source: e.source,
    reason: e.reason,
    toolInput: e.tool_input === undefined ? undefined : clip(JSON.stringify(e.tool_input), 300),
    promptId: e.prompt_id,
    claudeSessionId: e.session_id,
  });

  const state = nextState(e);
  if (!state) return;

  const prev = readState(dir);
  // 턴 밖에서 튀어나온 도구 이벤트는 상태에 반영 안 함.
  // Stop 뒤에 PostToolUse 없는 PreToolUse가 가끔 찍히는데 메인 트랜스크립트엔 흔적이 없음 (백그라운드 작업으로 추정).
  // 이걸 받아주면 끝난 세션이 계속 busy로 보임. 턴은 항상 UserPromptSubmit으로 시작하니까 idle에선 무시.
  const toolEvent = e.hook_event_name === 'PreToolUse' || e.hook_event_name === 'PostToolUse';
  if (toolEvent && prev?.state !== 'busy' && prev?.state !== 'waiting') return;
  writeState(dir, {
    state,
    at,
    event: e.hook_event_name,
    detail: clip(e.prompt ?? e.message) ?? (state === 'busy' ? prev?.detail : undefined),
    tool: e.tool_name ?? (state === 'busy' ? prev?.tool : undefined),
    transcriptPath: e.transcript_path ?? prev?.transcriptPath,
    // /clear 하면 claude 세션 ID가 바뀜 → 최신 걸 들고 있어야 트랜스크립트를 제대로 찾음
    claudeSessionId: e.session_id ?? prev?.claudeSessionId,
  });
}

// 훅이 실패해도 claude 흐름은 절대 막지 않기
main().catch(() => {}).finally(() => process.exit(0));
