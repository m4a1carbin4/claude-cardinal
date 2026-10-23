import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR, hookDir, sessionDir } from './paths.js';

export type Role = 'worker' | 'master';

// starting: tmux는 떴는데 claude가 아직 SessionStart 안 찍음 (신뢰 다이얼로그 등)
// idle:     입력 대기
// busy:     작업 중
// waiting:  권한 승인 같은 사람 손이 필요한 상태
// ended:    claude 종료
export type SessionState = 'starting' | 'idle' | 'busy' | 'waiting' | 'ended';

// 만들 때 한 번 쓰고 끝 (카디널 쪽 소유). 이름 ↔ 인스턴스를 잇는 유일한 곳
export interface SessionMeta {
  name: string;
  instanceId?: string; // 세션 고유 키 = 훅 폴더 이름. 없으면 예전 방식 세션
  tmux: string;
  role: Role;
  cwd: string;
  claudeSessionId: string; // 처음 띄울 때 지정한 ID. /clear 하면 claude 쪽 ID는 바뀜 (state 쪽 참고)
  claudeArgs: string[];
  createdAt: string;
  parent?: { name: string; instanceId: string }; // 이 세션을 만든 카디널 세션 (마스터가 워커를 띄운 경우)
}

// 훅이 계속 덮어씀 (claude 쪽 소유)
export interface SessionStateFile {
  state: SessionState;
  at: string;
  event: string;
  detail?: string;
  tool?: string;
  transcriptPath?: string;
  claudeSessionId?: string; // 훅이 마지막으로 받은 claude 세션 ID
  restoredInput?: boolean; // 응답 전 Esc 중단: claude 가 프롬프트를 입력창에 되돌려 놓았을 수 있음 (다음 send 가 비우고 시작)
}

const metaPath = (name: string) => path.join(sessionDir(name), 'meta.json');

// 훅 폴더. 예전 방식 세션(instanceId 없음)은 세션 폴더를 같이 썼음
export const stateDir = (meta: SessionMeta) => (meta.instanceId ? hookDir(meta.instanceId) : sessionDir(meta.name));
const statePath = (dir: string) => path.join(dir, 'state.json');
export const eventsPath = (dir: string) => path.join(dir, 'events.jsonl');

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

// 반쯤 쓴 파일을 누가 읽지 않게 tmp에 쓰고 rename.
// 폴더는 안 만듦: 훅 폴더가 지워진 뒤(purge) 늦게 온 훅이 폴더를 되살리지 않게
function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export const readMeta = (name: string) => readJson<SessionMeta>(metaPath(name));
export function writeMeta(meta: SessionMeta): void {
  fs.mkdirSync(sessionDir(meta.name), { recursive: true });
  writeJson(metaPath(meta.name), meta);
}

export const readState = (dir: string) => readJson<SessionStateFile>(statePath(dir));
export const writeState = (dir: string, s: SessionStateFile) => writeJson(statePath(dir), s);

export function appendEvent(dir: string, event: Record<string, unknown>): void {
  fs.appendFileSync(eventsPath(dir), JSON.stringify(event) + '\n');
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

// 이름 폴더 + 그 이름이 가리키던 훅 폴더까지 같이 지움
export function removeSession(name: string): void {
  const meta = readMeta(name);
  if (meta?.instanceId) fs.rmSync(hookDir(meta.instanceId), { recursive: true, force: true });
  fs.rmSync(sessionDir(name), { recursive: true, force: true });
}
