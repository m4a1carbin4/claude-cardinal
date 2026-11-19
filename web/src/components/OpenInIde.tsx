import { useState } from 'react';
import { LOCAL, effectiveHost, ideUrl, isIdeHost, saveIdeHost, savedIdeHost } from '../ide';

/**
 * 작업 폴더를 VS Code 로 열기. 대상(SSH 원격 호스트)은 이 브라우저 설정 > 서버 기본값(CARDINAL_IDE_HOST).
 * 링크가 안 열리는 브라우저·기기를 위해 경로 복사도 같이
 */
export function OpenInIde({ cwd, serverHost }: { cwd: string; serverHost?: string | null }) {
  const [saved, setSaved] = useState<string | null>(savedIdeHost);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const host = effectiveHost(saved, serverHost);
  const bad = draft.trim() !== '' && !isIdeHost(draft.trim());

  const copy = () => {
    navigator.clipboard?.writeText(cwd).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  const apply = (v: string | null) => {
    saveIdeHost(v);
    setSaved(v);
    setEditing(false);
  };

  return (
    <span className="open-ide">
      <a
        className="button ghost small"
        href={ideUrl(cwd, host)}
        title={
          host
            ? `VS Code Remote-SSH 로 ${host} 의 작업 폴더 열기 (이 기기에 VS Code 와 SSH 접속이 설정돼 있어야 함)`
            : '이 기기의 VS Code 로 작업 폴더 열기 (브라우저가 이 서버와 같은 기기에서 열려 있어야 함)'
        }
      >
        VS Code 로 열기{host ? ` · ${host}` : ''}
      </a>
      <button className="ghost small" onClick={copy} title="작업 폴더 경로 복사">
        {copied ? '복사됨' : '경로 복사'}
      </button>
      <button
        className="ghost small"
        onClick={() => {
          setDraft(saved && saved !== LOCAL ? saved : '');
          setEditing(!editing);
        }}
        title="어느 서버로 열지 (SSH 대상) 정하기"
      >
        ⚙
      </button>
      {editing && (
        <span className="open-ide-edit">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={serverHost ? `서버 기본값: ${serverHost}` : 'user@host 또는 ssh 별칭'}
            spellCheck={false}
            aria-label="VS Code SSH 대상"
          />
          <button className="small" disabled={!draft.trim() || bad} onClick={() => apply(draft.trim())}>
            저장
          </button>
          <button className="ghost small" onClick={() => apply(LOCAL)} title="원격 말고 이 기기에서 열기">
            이 기기
          </button>
          <button className="ghost small" onClick={() => apply(null)} title="서버 기본값을 따름">
            기본값
          </button>
          {bad && <span className="hint err">영문·숫자 . _ @ : - 만</span>}
        </span>
      )}
    </span>
  );
}
