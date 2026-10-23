import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await run('tmux', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// '=' 붙이면 접두사 매칭 말고 정확히 그 이름만 잡음
const sessionTarget = (t: string) => `=${t}`;
const paneTarget = (t: string) => `=${t}:`;

export async function hasSession(t: string): Promise<boolean> {
  try {
    await tmux('has-session', '-t', sessionTarget(t));
    return true;
  } catch {
    return false;
  }
}

export async function listSessions(): Promise<string[]> {
  try {
    const out = await tmux('list-sessions', '-F', '#{session_name}');
    return out.split('\n').filter(Boolean);
  } catch {
    // tmux 서버가 아예 안 떠 있으면 에러남 → 세션 없음
    return [];
  }
}

export async function killSession(t: string): Promise<void> {
  await tmux('kill-session', '-t', sessionTarget(t));
}

// lines > 0 이면 스크롤백까지 그만큼 더 가져옴
export async function capturePane(t: string, lines = 0, escapes = false): Promise<string> {
  const args = ['capture-pane', '-p', '-t', paneTarget(t)];
  if (lines > 0) args.push('-S', String(-lines));
  if (escapes) args.push('-e');
  return tmux(...args);
}

export async function sendKeys(t: string, ...keys: string[]): Promise<void> {
  await tmux('send-keys', '-t', paneTarget(t), ...keys);
}

// tmux 가 명령 하나로 받는 크기 한도 (클라이언트→서버 메시지 크기). set-buffer 인자로 텍스트를 넘기는데
// 실측 16,343바이트까지 됨 (tmux 3.6a). 버퍼 이름 길이 등 여유를 두고 16,000바이트. 이건 tmux 제약이라 따름
export const PASTE_MAX_BYTES = 16_000;

// 버퍼에 넣고 bracketed paste로 붙여넣기.
// send-keys로 줄바꿈 섞인 텍스트 보내면 중간에 엔터로 먹혀서 이렇게 함.
export async function pasteText(t: string, text: string): Promise<void> {
  const buf = `cardinal-${process.pid}-${Date.now()}`;
  await tmux('set-buffer', '-b', buf, '--', text);
  await tmux('paste-buffer', '-p', '-d', '-b', buf, '-t', paneTarget(t));
}

export async function paneWidth(t: string): Promise<number> {
  return Number((await tmux('display-message', '-p', '-t', paneTarget(t), '#{pane_width}')).trim()) || 0;
}

export async function setOption(t: string, option: string, value: string): Promise<void> {
  await tmux('set-option', '-t', sessionTarget(t), option, value);
}
