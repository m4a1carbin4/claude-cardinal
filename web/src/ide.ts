// 세션 작업 폴더를 VS Code 로 여는 링크 (브라우저가 도는 기기의 VS Code 가 열림)

/** 경로를 URL 에 넣을 수 있게 조각마다 인코딩 (슬래시는 그대로) */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** 이 기기에서 바로 여는 링크: 브라우저가 이 서버와 같은 기기에서 도는 경우 */
export function ideUrl(cwd: string): string {
  return `vscode://file${encodePath(cwd)}`;
}
