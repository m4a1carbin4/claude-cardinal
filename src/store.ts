import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR, sessionDir } from './paths.js';

export type Role = 'worker' | 'master';

// starting: tmux는 떴는데 claude가 아직 SessionStart 안 찍음 (신뢰 다이얼로그 등)
// idle:     입력 대기
// busy:     작업 중
// waiting:  권한 승인 같은 사람 손이 필요한 상태
// ended:    claude 종료
export type SessionState = 'starting' | 'idle' | 'busy' | 'waiting' | 'ended';

// 만들 때 한 번 쓰고 끝 (카디널 쪽 소유)
export interface SessionMeta {
  name: string;
  tmux: string;
  role: Role;
  cwd: string;
  claudeSessionId: string;
  claudeArgs: string[];
  createdAt: string;
}

// 훅이 계속 덮어씀 (claude 쪽 소유)
export interface SessionStateFile {
  state: SessionState;
  at: string;
  event: string;
  detail?: string;
  tool?: string;
  transcriptPath?: string;
}

// meta랑 state 파일을 나눈 건 쓰는 주체가 달라서 서로 덮어쓰는 일 없게 하려고
const metaPath = (name: string) => path.join(sessionDir(name), 'meta.json');
const statePath = (name: string) => path.join(sessionDir(name), 'state.json');
export const eventsPath = (name: string) => path.join(sessionDir(name), 'events.jsonl');

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

// 반쯤 쓴 파일을 누가 읽지 않게 tmp에 쓰고 rename
function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export const readMeta = (name: string) => readJson<SessionMeta>(metaPath(name));
export const writeMeta = (meta: SessionMeta) => writeJson(metaPath(meta.name), meta);
export const readState = (name: string) => readJson<SessionStateFile>(statePath(name));
export const writeState = (name: string, s: SessionStateFile) => writeJson(statePath(name), s);

export function appendEvent(name: string, event: Record<string, unknown>): void {
  fs.mkdirSync(sessionDir(name), { recursive: true });
  fs.appendFileSync(eventsPath(name), JSON.stringify(event) + '\n');
}

export function listNames(): string[] {
  try {
    return fs
      .readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(metaPath(d.name)))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export function removeSessionDir(name: string): void {
  fs.rmSync(sessionDir(name), { recursive: true, force: true });
}
