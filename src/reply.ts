// 세션 안 에이전트가 외부 채널 이벤트에 답장하는 도구 (cardinal reply).
// 텍스트/파일 검사는 여기서 하고, 실제 발신은 카디널 서버가 함.
import fs from 'node:fs';
import path from 'node:path';
import { CARDINAL_HOME } from './paths.js';

// 디스코드 기준. 서버 부스트 없으면 파일당 10MB, 메시지당 첨부 10개
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 10;

interface ServerInfo {
  url: string;
  token?: string;
}

// 서버가 뜰 때 ~/.cardinal/server.json 에 주소/토큰을 써둠. 환경변수가 있으면 그게 우선
export function serverInfo(): ServerInfo {
  if (process.env.CARDINAL_SERVER_URL) return { url: process.env.CARDINAL_SERVER_URL, token: process.env.CARDINAL_TOKEN };
  try {
    const info = JSON.parse(fs.readFileSync(path.join(CARDINAL_HOME, 'server.json'), 'utf8')) as ServerInfo;
    return { url: info.url, token: process.env.CARDINAL_TOKEN ?? info.token };
  } catch {
    throw new Error('카디널 서버 정보 없음 (서버가 안 떠 있음?). CARDINAL_SERVER_URL 로 직접 지정 가능');
  }
}

export function checkFiles(files: string[]): string[] {
  if (files.length > MAX_FILES) throw new Error(`첨부는 최대 ${MAX_FILES}개`);
  return files.map((f) => {
    const abs = path.resolve(f);
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new Error(`파일 없음: ${f}`);
    if (st.size > MAX_FILE_BYTES) throw new Error(`파일이 너무 큼 (${(st.size / 1024 / 1024).toFixed(1)}MB > 10MB): ${f}`);
    return abs;
  });
}

export async function reply(eventId: string, text: string, files: string[]): Promise<unknown> {
  if (!text.trim() && !files.length) throw new Error('보낼 텍스트나 파일이 필요');
  const abs = checkFiles(files);
  const { url, token } = serverInfo();

  const form = new FormData();
  form.set('text', text);
  form.set('session', process.env.CARDINAL_SESSION ?? '');
  for (const f of abs) form.append('files', new Blob([fs.readFileSync(f)]), path.basename(f));

  const res = await fetch(`${url}/api/events/${encodeURIComponent(eventId)}/reply`, {
    method: 'POST',
    body: form,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(body?.detail ?? `서버 응답 ${res.status}`);
  return body;
}
