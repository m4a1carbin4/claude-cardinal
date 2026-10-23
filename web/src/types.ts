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

export interface Session {
  id: string; // 세션 고유 키 (instanceId)
  name: string;
  role: Role;
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
}

export interface Turn {
  prompt: string;
  promptAt?: string;
  texts: string[];
  tools: { name: string; input: string }[];
  complete: boolean;
  interrupted: boolean;
  endedAt?: string;
}

export interface Report {
  status: { state: State; event?: string; detail?: string; trustPrompt?: boolean; alive: boolean };
  phase: Phase;
  transcript?: string;
  turn?: Turn;
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
}

export interface SendResult {
  sentAt?: number;
  accepted?: boolean;
  timedOut?: boolean;
  interrupted?: boolean;
  last?: string | null;
  status?: { state: State; event?: string };
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
}
