import { useCallback, useEffect, useRef, useState } from 'react';
import { api, driveFileUrl, uploadFiles } from '../api';
import { fmtSize } from '../format';
import { useDriveChanged } from '../hooks';
import type { DriveDir, DriveEntry } from '../types';

const TEXT_MAX = 2 * 1024 * 1024; // 서버 MAX_TEXT_BYTES
const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, '') || '/';
const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
// 지우기/옮기기 안 되는 자리 (서버 drive.py protected 와 같은 규칙)
const isProtected = (p: string) => ['/', '/shared', '/sessions'].includes(p) || /^\/sessions\/[^/]+$/.test(p);

function fmtTime(sec: number): string {
  const d = new Date(sec * 1000);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
}

// 웹드라이브 탐색기. 사람과 세션이 같이 쓰는 파일 공간 (서버 drive.py)
// root: 처음 열 폴더 (세션 탭이면 그 세션 폴더). onPick 이 있으면 파일 고르기 모드 (요청 첨부용)
export function DrivePanel({ root = '/', onPick }: { root?: string; onPick?: (e: DriveEntry) => void }) {
  const [path, setPath] = useState(root);
  const [dir, setDir] = useState<DriveDir | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [newDir, setNewDir] = useState<string | null>(null);
  const [newFile, setNewFile] = useState<string | null>(null);
  // 글 편집기: isNew 면 새 파일 (있으면 덮어쓰지 않음)
  const [editing, setEditing] = useState<{ path: string; content: string; isNew: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [copied, setCopied] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.driveList(path).then(
      (d) => {
        setDir(d);
        setError('');
      },
      (e) => setError((e as Error).message),
    );
  }, [path]);
  useEffect(load, [load]);
  // 세션이 drive_upload 하거나 다른 창에서 바꾸면 바로 반영
  useDriveChanged(path, load);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  async function upload(files: File[]) {
    if (!files.length) return;
    setError('');
    setProgress(0);
    try {
      await uploadFiles({ dir: path }, files, setProgress);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(text);
        setTimeout(() => setCopied(''), 1500);
      },
      () => setError('클립보드에 못 넣음'),
    );
  }

  const crumbs = path.split('/').filter(Boolean);

  return (
    <div
      className={`panel wide drive ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        if (onPick || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
      onDrop={(e) => {
        if (onPick) return;
        e.preventDefault();
        setDrag(false);
        void upload([...e.dataTransfer.files]);
      }}
    >
      <div className="row wrap">
        <nav className="crumbs">
          <button className="ghost small" onClick={() => setPath('/')}>
            드라이브
          </button>
          {crumbs.map((c, i) => {
            const p = '/' + crumbs.slice(0, i + 1).join('/');
            return (
              <span key={p}>
                <span className="muted">/</span>
                <button className="ghost small" onClick={() => setPath(p)} disabled={p === path}>
                  {c}
                </button>
              </span>
            );
          })}
        </nav>
        <span className="spacer" />
        {root !== '/' && path !== root && (
          <button className="ghost small" onClick={() => setPath(root)}>
            처음 폴더로
          </button>
        )}
        <button className="ghost small" onClick={load} title="다시 읽기">
          ↻
        </button>
        {!onPick && (
          <>
            <button className="ghost small" onClick={() => setNewDir('')}>
              + 폴더
            </button>
            <button className="ghost small" onClick={() => setNewFile('')}>
              + 글 파일
            </button>
            <button className="primary small" onClick={() => fileInput.current?.click()} disabled={progress !== null}>
              올리기
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void upload([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>

      {dir && (
        <div className="row wrap small muted">
          <span title="세션이 이 경로로 읽고 씀 (drive_list / drive_load / drive_upload)">
            드라이브 경로 <code>{dir.path}</code>
          </span>
          <button className="ghost small" onClick={() => copy(dir.local_path)} title={dir.local_path}>
            {copied === dir.local_path ? '복사됨' : '로컬 경로 복사'}
          </button>
        </div>
      )}
      {progress !== null && (
        <div className="progress" title="올리는 중">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {error && <div className="alert err">{error}</div>}

      {newDir !== null && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const n = newDir.trim();
            if (!n) return;
            setNewDir(null);
            void run(() => api.driveMkdir(join(path, n)));
          }}
        >
          <input className="grow" value={newDir} onChange={(e) => setNewDir(e.target.value)} placeholder="새 폴더 이름" autoFocus />
          <button className="primary small" disabled={!newDir.trim()}>
            만들기
          </button>
          <button type="button" className="ghost small" onClick={() => setNewDir(null)}>
            취소
          </button>
        </form>
      )}

      {newFile !== null && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const n = newFile.trim();
            if (!n) return;
            setNewFile(null);
            setEditing({ path: join(path, n), content: '', isNew: true });
          }}
        >
          <input className="grow" value={newFile} onChange={(e) => setNewFile(e.target.value)} placeholder="새 파일 이름 (예: notes.md)" autoFocus />
          <button className="primary small" disabled={!newFile.trim()}>
            만들기
          </button>
          <button type="button" className="ghost small" onClick={() => setNewFile(null)}>
            취소
          </button>
        </form>
      )}

      {editing && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !saving && setEditing(null)}>
          <form
            className="modal wide-modal"
            onSubmit={async (e) => {
              e.preventDefault();
              setSaving(true);
              setError('');
              try {
                await api.driveWriteText(editing.path, editing.content, !editing.isNew);
                setEditing(null);
                load();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            <div className="modal-head">
              <h2>{editing.isNew ? '새 파일' : '편집'}</h2>
              <code className="small">{editing.path}</code>
            </div>
            {error && <div className="alert err">{error}</div>}
            <textarea
              className="editor"
              value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              spellCheck={false}
              autoFocus
            />
            <div className="modal-foot">
              <span className="muted small">⌘/Ctrl + S 저장</span>
              <span className="spacer" />
              <button type="button" className="ghost" onClick={() => setEditing(null)} disabled={saving}>
                취소
              </button>
              <button className="primary" disabled={saving}>
                {saving ? '저장 중…' : '저장'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="table-wrap">
        <table className="drive-table">
          <thead>
            <tr>
              <th>이름</th>
              <th className="num-col">크기</th>
              <th>바뀐 때</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {path !== '/' && (
              <tr>
                <td colSpan={4}>
                  <button className="link" onClick={() => setPath(parentOf(path))}>
                    📁 ..
                  </button>
                </td>
              </tr>
            )}
            {dir?.entries.map((e) => (
              <tr key={e.path}>
                <td className="name-col">
                  {renaming?.path === e.path ? (
                    <form
                      className="row"
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        const v = renaming.value.trim();
                        setRenaming(null);
                        // / 로 시작하면 드라이브 안 다른 곳으로 옮기기, 아니면 같은 폴더에서 이름만
                        if (v && v !== e.name) void run(() => api.driveMove(e.path, v.startsWith('/') ? v : join(path, v)));
                      }}
                    >
                      <input
                        className="grow"
                        value={renaming.value}
                        onChange={(ev) => setRenaming({ path: e.path, value: ev.target.value })}
                        onKeyDown={(ev) => ev.key === 'Escape' && setRenaming(null)}
                        title="새 이름, 또는 / 로 시작하는 드라이브 경로로 옮기기"
                        autoFocus
                      />
                      <button className="primary small">확인</button>
                    </form>
                  ) : e.type === 'dir' ? (
                    <button className="link" onClick={() => setPath(e.path)}>
                      📁 {e.name}
                    </button>
                  ) : (
                    <a className="link" href={driveFileUrl(e.path)} target="_blank" rel="noreferrer" title="브라우저에서 열기">
                      📄 {e.name}
                    </a>
                  )}
                </td>
                <td className="num-col muted">{fmtSize(e.size)}</td>
                <td className="muted nowrap">{fmtTime(e.mtime)}</td>
                <td className="act-col">
                  {onPick ? (
                    e.type === 'file' && (
                      <button className="primary small" onClick={() => onPick(e)}>
                        고르기
                      </button>
                    )
                  ) : confirmDel === e.path ? (
                    <span className="row">
                      <button
                        className="small danger"
                        onClick={() => {
                          setConfirmDel(null);
                          void run(() => api.driveDelete(e.path, e.type === 'dir'));
                        }}
                      >
                        {e.type === 'dir' ? '폴더째 지우기' : '지우기'}
                      </button>
                      <button className="ghost small" onClick={() => setConfirmDel(null)}>
                        취소
                      </button>
                    </span>
                  ) : (
                    <span className="row">
                      {e.type === 'file' && (
                        <a className="ghost small btn" href={driveFileUrl(e.path, true)} title="받기">
                          ⬇
                        </a>
                      )}
                      {e.type === 'file' && (e.size ?? 0) <= TEXT_MAX && (
                        <button
                          className="ghost small"
                          title="글 파일 내용 고치기"
                          onClick={() =>
                            run(async () => {
                              const t = await api.driveReadText(e.path);
                              setEditing({ path: e.path, content: t.content, isNew: false });
                            })
                          }
                        >
                          편집
                        </button>
                      )}
                      <button className="ghost small" onClick={() => copy(e.path)} title="드라이브 경로 복사 (세션에 알려줄 때)">
                        {copied === e.path ? '복사됨' : '경로'}
                      </button>
                      {!isProtected(e.path) && (
                        <>
                          <button className="ghost small" onClick={() => setRenaming({ path: e.path, value: e.name })} title="이름 바꾸기 / 옮기기">
                            이름
                          </button>
                          <button className="ghost small danger" onClick={() => setConfirmDel(e.path)} title="지우기">
                            ✕
                          </button>
                        </>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {dir && dir.entries.length === 0 && (
              <tr>
                <td colSpan={4} className="empty small">
                  {onPick ? '파일 없음' : '비어 있음. 파일을 여기로 끌어 놓거나 “올리기”'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!onPick && <div className="muted small">파일을 이 화면에 끌어 놓으면 지금 폴더에 올라가요. 세션도 drive_* 도구로 같은 파일을 읽고 쓰고 옮기고 지워요.</div>}
    </div>
  );
}
