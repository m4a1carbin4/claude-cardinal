import { useState } from 'react';
import { ideUrl } from '../ide';

/** 작업 폴더를 VS Code 로 열기. 링크가 안 열리는 브라우저·기기를 위해 경로 복사도 같이 */
export function OpenInIde({ cwd }: { cwd: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(cwd).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <span className="open-ide">
      <a
        className="button ghost small"
        href={ideUrl(cwd)}
        title="이 기기의 VS Code 로 작업 폴더 열기 (브라우저가 이 서버와 같은 기기에서 열려 있어야 함)"
      >
        VS Code 로 열기
      </a>
      <button className="ghost small" onClick={copy} title="작업 폴더 경로 복사">
        {copied ? '복사됨' : '경로 복사'}
      </button>
    </span>
  );
}
