// 세션 작업 폴더를 VS Code 로 여는 링크

/** 경로를 URL 에 넣을 수 있게 조각마다 인코딩 (슬래시는 그대로) */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

// SSH 대상: ~/.ssh/config 별칭이나 user@host (IP, 테일넷 이름 포함). URL 에 그대로 들어가서 이 글자만
const HOST_RE = /^[A-Za-z0-9._@:[\]-]{1,128}$/;
export const isIdeHost = (h: string) => HOST_RE.test(h);

/** 'local' = 서버 기본값이 있어도 이 기기에서 열기 */
export const LOCAL = 'local';
const KEY = 'cardinal.ide.host';

/** 이 브라우저에 저장한 대상. 없으면 null (서버 기본값을 따름) */
export function savedIdeHost(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveIdeHost(v: string | null) {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    // 저장 못 하는 환경이면 이번 화면에서만
  }
}

/** 쓸 대상: 이 브라우저 설정 > 서버 기본값 (CARDINAL_IDE_HOST). null 이면 이 기기에서 열기 */
export function effectiveHost(saved: string | null, serverDefault?: string | null): string | null {
  const h = saved ?? serverDefault ?? null;
  return h && h !== LOCAL && isIdeHost(h) ? h : null;
}

/**
 * host 가 있으면 SSH 원격 링크 (보는 기기의 VS Code + Remote-SSH 가 그 서버의 폴더를 엶),
 * 없으면 이 기기에서 바로 여는 링크 (브라우저가 이 서버와 같은 기기일 때)
 */
export function ideUrl(cwd: string, host?: string | null): string {
  // windowId=_blank: 이미 열려 있는 VS Code 창을 재활용하지 않고 새 창으로 (세션마다 창이 따로)
  const path = `${encodePath(cwd)}?windowId=_blank`;
  return host ? `vscode://vscode-remote/ssh-remote+${host}${path}` : `vscode://file${path}`;
}
