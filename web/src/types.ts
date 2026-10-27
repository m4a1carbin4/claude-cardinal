// 카디널 서버(FastAPI) 응답 형태. server/cardinal_server/db.py, app.py 와 맞춤

export type State = 'starting' | 'idle' | 'busy' | 'waiting' | 'ended';
export type Role = 'worker' | 'master';
export type Phase = 'dead' | 'starting' | 'working' | 'waiting' | 'done' | 'interrupted';

export interface Route {
  id: number;
  session_id: string;
  platform: 'discord' | 'local' | '*';
  channel: string | null;
  trigger: string | null;
  match: 'prefix' | 'contains' | 'regex' | 'mention';
  auto_reply: boolean;
  enabled: boolean;
  created_at: string;
}

export type Backend = 'tmux' | 'sdk';
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions' | 'auto';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// stdio: command/args/env, http·sse: url/headers. 목록에선 env/headers 값이 *** 로 가려져 옴
export interface McpServerConfig {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

// server/cardinal_server/app.py SdkOptionsIn 과 같은 모양
export interface SdkOptions {
  permission_mode: PermissionMode;
  model: string | null;
  fallback_model: string | null;
  effort: Effort | null;
  append_prompt: string | null;
  mcp_servers: Record<string, McpServerConfig>;
  strict_mcp_config: boolean;
  allowed_tools: string[];
  disallowed_tools: string[];
  add_dirs: string[];
  env: Record<string, string>;
  partial: boolean;
  max_turns: number | null;
  max_budget_usd: number | null;
  setting_sources: ('user' | 'project' | 'local')[] | null;
  question_timeout_s: number | null;
  resume_on_start: boolean;
  chrome: boolean | null; // Claude in Chrome. null: 전역 설정(~/.claude.json) 따름
}

export interface Session {
  id: string; // 세션 고유 키 (instanceId)
  name: string;
  role: Role;
  backend: Backend;
  sdk_options: SdkOptions | null; // backend=sdk 일 때만
  mcp: boolean; // 카디널 MCP(mcp__cardinal__*)에 붙어 있음. false 면 서버 없이 띄운 세션이라 모델이 CLI 를 씀
  tmux: string;
  cwd: string;
  claude_args: string[];
  created_at: string;
  deleted_at: string | null;
  alive: boolean;
  state: State;
  state_at: string | null;
  last_event: string | null;
  detail: string | null;
  tool: string | null;
  transcript_path: string | null;
  claude_session_id: string | null;
  parent_id: string | null; // 이 세션을 만든 세션 (마스터가 띄운 워커)
  parent_name: string | null;
  updated_at: string;
  routes?: Route[];
  pending?: Pending[]; // sdk 세션 상세에만
}

export interface Turn {
  prompt: string;
  promptAt?: string;
  texts: string[];
  tools: { name: string; input: string }[];
  complete: boolean;
  interrupted: boolean;
  endedAt?: string;
  origin?: 'human' | 'agent'; // sdk: 우리가 보낸 턴 / 에이전트가 스스로 (백그라운드 알림 등)
  result?: TurnResult | null; // sdk: ResultMessage 요약
}

export interface TurnResult {
  subtype: string;
  is_error: boolean;
  terminal_reason: string | null;
  stop_reason: string | null;
  num_turns: number;
  duration_ms: number;
  total_cost_usd: number | null;
  result: string | null;
  errors?: unknown;
  api_error_status?: number | null;
}

// sdk_turns 행 (GET …/turns)
export interface SdkTurnRow {
  id: number;
  session_id: string;
  origin: 'human' | 'agent';
  prompt: string;
  prompt_at: string;
  texts: string[];
  tools: { name: string; input: string }[];
  complete: boolean;
  interrupted: boolean;
  result: TurnResult | null;
  ended_at: string | null;
}

// 사람 답을 기다리는 질문(AskUserQuestion) / 권한 확인
export interface Pending {
  id: string;
  kind: 'question' | 'permission';
  tool: string;
  input: Record<string, unknown>;
  created_at: string;
  title: string | null;
  description: string | null;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface McpStatus {
  mcpServers: {
    name: string;
    status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
    serverInfo?: { name: string; version: string };
    error?: string;
    config?: Record<string, unknown>;
    scope?: string;
    tools?: { name: string; description?: string }[];
  }[];
}

export interface ContextUsage {
  categories: { name: string; tokens: number; color: string; isDeferred?: boolean }[];
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
  isAutoCompactEnabled: boolean;
}

export interface Report {
  status: { state: State; event?: string; detail?: string; trustPrompt?: boolean; alive: boolean };
  phase: Phase;
  transcript?: string;
  turn?: Turn;
  pending?: Pending[]; // sdk
}

export interface HookEvent {
  id: number;
  session_id: string;
  at: string;
  event: string;
  tool: string | null;
  data: Record<string, unknown>;
}

export interface Attachment {
  filename: string;
  size?: number | null;
  content_type?: string | null;
  url?: string | null;
  local_path?: string;
  error?: string;
}

export interface Delivery {
  id: number;
  event_id: string;
  session_id: string;
  session_name: string;
  route_id: number | null;
  status: 'pending' | 'sent' | 'failed';
  error: string | null;
  delivered_at: string;
}

export interface Reply {
  id: number;
  event_id: string;
  session_id: string | null;
  source: 'tool' | 'auto';
  text: string;
  files: { filename: string; size: number; content_type: string | null }[];
  status: 'sent' | 'failed';
  error: string | null;
  created_at: string;
}

export interface ChannelEvent {
  id: string;
  platform: string;
  channel_id: string | null;
  channel_name: string | null;
  guild: string | null;
  message_id: string | null;
  author: string | null;
  content: string;
  attachments: Attachment[];
  received_at: string;
  deliveries: Delivery[];
  replies: Reply[];
}

export interface Health {
  ok: boolean;
  channels: { local: string; discord: string };
  sessions: number;
  sdk?: { enabled: boolean; default_backend: Backend; alive: number };
}

export interface SendResult {
  sentAt?: number;
  accepted?: boolean;
  timedOut?: boolean;
  interrupted?: boolean;
  last?: string | null;
  status?: { state: State; event?: string };
}

// 질문 답: {질문 텍스트: 고른 답}. 권한: allow/message
export interface AnswerInput {
  answers?: Record<string, string>;
  allow?: boolean;
  message?: string;
}

export interface RouteInput {
  platform: Route['platform'];
  channel: string | null;
  trigger: string | null;
  match: Route['match'];
  auto_reply: boolean;
}

export interface CreateInput {
  name: string;
  role: Role;
  cwd?: string;
  trust?: boolean;
  prompt?: string;
  args?: string[];
  routes: RouteInput[];
  backend?: Backend;
  sdk?: Partial<SdkOptions>;
}
