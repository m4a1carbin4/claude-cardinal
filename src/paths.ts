import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 프로젝트 루트 (dist/ 한 단계 위)
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 세션 메타/상태/이벤트 로그가 쌓이는 곳
export const CARDINAL_HOME = process.env.CARDINAL_HOME ?? path.join(os.homedir(), '.cardinal');
export const SESSIONS_DIR = path.join(CARDINAL_HOME, 'sessions');

// 카디널이 만든 tmux 세션은 전부 이 접두사를 붙임
export const TMUX_PREFIX = 'cardinal-';

export const sessionDir = (name: string) => path.join(SESSIONS_DIR, name);

// 세션 인스턴스마다 훅 전용 폴더 하나. 훅은 여기만 씀 (세션 이름은 모름).
// 이름 ↔ 인스턴스 연결은 sessions/<이름>/meta.json 의 instanceId 로만 함.
export const HOOKS_DIR = path.join(CARDINAL_HOME, 'hooks');
export const hookDir = (instanceId: string) => path.join(HOOKS_DIR, instanceId);
export const tmuxName = (name: string) => TMUX_PREFIX + name;

// 모든 세션이 도는 고정 작업 폴더. 한 곳으로 고정하면 트랜스크립트 경로가 세션 ID만으로 정해지고,
// 신뢰 다이얼로그도 이 폴더에서 한 번만 받으면 끝.
export const WORKSPACE = process.env.CARDINAL_WORKSPACE ?? path.join(CARDINAL_HOME, 'workspace');

// claude가 트랜스크립트 쌓는 곳: <CLAUDE_CONFIG_DIR>/projects/<작업 폴더 경로에서 영숫자 아닌 건 전부 '-'>/<세션 ID>.jsonl
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');

export function transcriptPath(workspace: string, claudeSessionId: string): string {
  return path.join(CLAUDE_DIR, 'projects', workspace.replace(/[^A-Za-z0-9]/g, '-'), `${claudeSessionId}.jsonl`);
}
