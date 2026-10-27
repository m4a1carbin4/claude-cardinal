import { useCallback, useRef, useState } from 'react';
import { uploadFiles } from '../api';
import { fmtSize } from '../format';
import type { DriveEntry } from '../types';
import { DrivePanel } from './DrivePanel';

// 요청에 붙이는 파일. 고르면 바로 세션 드라이브 폴더(/sessions/<이름>/attachments)에 올라가고,
// 보낼 때는 드라이브 경로만 넘김 (서버가 지시 뒤에 드라이브 경로 + 로컬 경로 안내를 붙임)
export function useAttachments(session: string) {
  const [items, setItems] = useState<DriveEntry[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setError('');
      setProgress(0);
      try {
        const saved = await uploadFiles({ session }, files, setProgress);
        setItems((cur) => [...cur, ...saved]);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setProgress(null);
      }
    },
    [session],
  );
  const add = useCallback((e: DriveEntry) => setItems((cur) => (cur.some((x) => x.path === e.path) ? cur : [...cur, e])), []);
  const remove = useCallback((path: string) => setItems((cur) => cur.filter((x) => x.path !== path)), []);
  const clear = useCallback(() => setItems([]), []);

  return { items, paths: items.map((x) => x.path), uploading: progress !== null, progress, error, addFiles, add, remove, clear };
}

export type Attachments = ReturnType<typeof useAttachments>;

// 입력창 옆 첨부 줄: 📎 파일 고르기, 드라이브에서 고르기, 붙인 파일 목록
export function AttachBar({ session, att }: { session: string; att: Attachments }) {
  const input = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);

  return (
    <div className="attach-bar">
      <button type="button" className="ghost small" onClick={() => input.current?.click()} disabled={att.uploading} title="파일 붙이기 (세션 드라이브 폴더에 저장됨). 입력창에 끌어 놓거나 붙여넣어도 돼요">
        📎 파일
      </button>
      <button type="button" className="ghost small" onClick={() => setPicking(true)} title="웹드라이브에 있는 파일 붙이기">
        드라이브에서
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void att.addFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      {att.uploading && <span className="muted small">올리는 중 {Math.round((att.progress ?? 0) * 100)}%</span>}
      {att.items.map((x) => (
        <span key={x.path} className="file-chip" title={`${x.path}\n${x.local_path}`}>
          📎 {x.name}
          {x.size != null && <span className="muted"> · {fmtSize(x.size)}</span>}
          <button type="button" className="chip-x" onClick={() => att.remove(x.path)} title="빼기 (드라이브 파일은 남음)">
            ✕
          </button>
        </span>
      ))}
      {att.error && <span className="err-text small">{att.error}</span>}

      {picking && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setPicking(false)}>
          <div className="modal wide-modal">
            <div className="modal-head">
              <h2>드라이브에서 붙이기</h2>
              <button className="ghost small" onClick={() => setPicking(false)}>
                닫기
              </button>
            </div>
            <DrivePanel
              root={`/sessions/${session}`}
              onPick={(e) => {
                att.add(e);
                setPicking(false);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// 입력창에 끌어 놓기 / 붙여넣기(스크린샷 등)로 첨부
export function attachHandlers(att: Attachments) {
  return {
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault();
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      void att.addFiles([...e.dataTransfer.files]);
    },
    onPaste: (e: React.ClipboardEvent) => {
      const files = [...e.clipboardData.files];
      if (!files.length) return;
      e.preventDefault();
      void att.addFiles(files);
    },
  };
}
