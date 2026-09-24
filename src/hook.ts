// Claude Code 훅으로 불리는 스크립트. stdin으로 훅 이벤트 JSON 받아서 상태 파일 갱신.
// 주의: stdout에 뭐 찍으면 SessionStart/UserPromptSubmit 같은 건 컨텍스트에 들어가버림 → 절대 출력 금지.
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

async function main() {
  const name = process.env.CARDINAL_SESSION;
  if (!name) return; // 카디널이 띄운 세션 아니면 무시

  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const e = JSON.parse(raw) as HookInput;
  const at = new Date().toISOString();

  appendEvent(name, {
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
  });

  const state = nextState(e);
  if (!state) return;

  const prev = readState(name);
  // 턴 밖에서 튀어나온 도구 이벤트는 상태에 반영 안 함.
  // Stop 뒤에 PostToolUse 없는 PreToolUse가 가끔 찍히는데 메인 트랜스크립트엔 흔적이 없음 (백그라운드 작업으로 추정).
  // 이걸 받아주면 끝난 세션이 계속 busy로 보임. 턴은 항상 UserPromptSubmit으로 시작하니까 idle에선 무시.
  const toolEvent = e.hook_event_name === 'PreToolUse' || e.hook_event_name === 'PostToolUse';
  if (toolEvent && prev?.state !== 'busy' && prev?.state !== 'waiting') return;
  writeState(name, {
    state,
    at,
    event: e.hook_event_name,
    detail: clip(e.prompt ?? e.message) ?? (state === 'busy' ? prev?.detail : undefined),
    tool: e.tool_name ?? (state === 'busy' ? prev?.tool : undefined),
    transcriptPath: e.transcript_path ?? prev?.transcriptPath,
  });
}

// 훅이 실패해도 claude 흐름은 절대 막지 않기
main().catch(() => {}).finally(() => process.exit(0));
