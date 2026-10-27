# Webdrive

[한국어](drive.md) · Related: [server](server.en.md), [Cardinal MCP](mcp.en.md), [web UI](web-ui.en.md)

A **file space shared by humans (web UI) and sessions (models)**. For handing result files back and forth, attaching files to a request, or passing files between sessions. Only exists while the server is running (a server feature).

## Where

```
$CARDINAL_HOME/drive          (CARDINAL_DRIVE 로 바꿈, 기본 ~/.cardinal/drive)
├ shared/                     다 같이 쓰는 곳
└ sessions/<세션 이름>/        세션마다 하나
    └ attachments/            사람이 요청에 붙인 파일
```

(Override with `CARDINAL_DRIVE`, default `~/.cardinal/drive`. `shared/` is common to everyone, `sessions/<session name>/` is one per session, `attachments/` holds files a human attached to a request.)

- **Rule: every session has its own drive folder.** Sessions created through the server get it at creation (before the first instruction); tmux sessions made directly with the CLI get it when they're synced. The server also reconciles once at startup.
- The folder name is the session name. Reusing a name (same name after `kill --purge`) picks the same folder back up. Deleting a session doesn't delete its drive folder (it may hold human files).
- Drive paths are always drive-relative and start with `/` (`/shared/a.txt`). In session tools, a path without `/` is **relative to that session's folder** (`result.txt` → `/sessions/<me>/result.txt`).
- The root, `/shared`, `/sessions`, and `/sessions/<name>` themselves can't be deleted or moved (their contents can).
- No escaping the drive: paths that climb above the root with `..` and symlinks pointing outside the drive are refused (and left out of listings).

## Letting sessions read it

The drive is attached as an additional directory, so sessions read drive files without a permission prompt even though they're outside the working dir.

- SDK sessions: the drive folder is always in `add_dirs`
- tmux sessions (created by the server): `--add-dir=<drive>` in the claude args. `--add-dir` takes multiple values, so it has to be joined with `=`; otherwise it swallows the first instruction that follows as a folder (measured)

The prompts (SDK `COMMON_PROMPT`, tmux `MCP_COMMON_PROMPT`) and the MCP instructions say "your folder is /sessions/<name>, the shared one is /shared, the tools work like this".

## Human side (REST)

| Method | Path | |
| --- | --- | --- |
| GET | `/api/drive?path=/` | folder contents. Entries: `name, path, type(file/dir), size, mtime, content_type, local_path` |
| GET | `/api/drive/file?path=[&download=true]` | get a file. Default is view in the browser (inline); `download` downloads it |
| GET | `/api/drive/text?path=` | contents of a UTF-8 text file (up to 2MB; binary → 400) |
| PUT | `/api/drive/text` | `{path, content, overwrite=true}` create/edit a text file. Creates folders as needed. `overwrite=false` → new files only |
| POST | `/api/drive/upload` | multipart `path` (folder, default `/shared`), `files[]`, `overwrite`. Name clash → `a (1).txt`. Per-file limit `CARDINAL_DRIVE_MAX_MB` (default 1024), over it → 413 |
| POST | `/api/drive/mkdir` | `{path}` |
| POST | `/api/drive/move` | `{src, dst, overwrite}` move/rename. If `dst` is an existing folder, moves into it |
| DELETE | `/api/drive?path=[&recursive=true]` | delete. Non-empty folders need `recursive` |
| POST | `/api/sessions/<name>/attachments` | save files to attach to a request into `/sessions/<name>/attachments/`. Pass the returned `path` as `attachments` on send |

- Uploads are written in chunks to a temp file (`.cardinal-up-…`) and renamed once complete. Over the limit or cut off → the temp file is removed. Temp files don't show up in listings.
- Changes broadcast `{"type":"drive","path":<changed folder>}` on `/ws/events`. If the web UI is showing that folder, it reloads (so uploads by sessions show up right away too).

## Attaching files to a request

Give `attachments: [drive paths…]` to `POST /api/sessions/<name>/send` or to `send` on `/ws/sdk/<name>`, and the server appends a note after the instruction (same text for tmux and SDK):

```
첨부한 메모에 적힌 코드명만 한 단어로 답해.

[첨부 1개 — 카디널 웹드라이브. 로컬 경로를 바로 읽거나 mcp__cardinal__drive_load 로 작업 폴더에 복사]
- /sessions/dw1/attachments/memo.txt (text/plain, 0KB) → /Users/…/.cardinal/drive/sessions/dw1/attachments/memo.txt
```

(The first line is the instruction: "Answer with just the code name written in the attached memo, one word." The bracketed note reads "1 attachment — Cardinal webdrive. Read the local path directly or copy it to the working dir with mcp__cardinal__drive_load", followed by one line per file: drive path (type, size) → local path.)

- You can send attachments alone, with an empty instruction.
- A drive path that doesn't exist → 400 (blocked before sending).
- Web UI: pick with "📎 파일" (or drag-and-drop / paste) in the input box on the conversation or send tab and it's uploaded straight to the session's attachments folder; "드라이브에서" (from drive) picks an existing file.
- The master tools `session_new` and `session_send` also take `attachments` (handing files to a worker).

## Session side (Cardinal MCP tools, worker and master)

| Tool | What it does |
| --- | --- |
| `drive_list(path?)` | folder contents. Defaults to my folder. Each entry has `local_path` |
| `drive_read(path)` | read a text file (UTF-8, up to 2MB) |
| `drive_write(path, content, overwrite=true)` | create/edit a text file (whole contents) |
| `drive_move(src, dst, overwrite?)` | move/rename within the drive |
| `drive_delete(path, recursive?)` | delete |
| `drive_upload(src, path?, keep_source?, overwrite?)` | **move local → drive** (moves by default, copies with `keep_source`). Relative `src` is relative to the working dir. Without `path`, same name in my folder |
| `drive_load(path, dest?, overwrite?)` | copy drive → local (drive side untouched). Without `dest`, same name in the working dir |

Humans and sessions get the same CRUD: create (upload / `drive_write`·`drive_upload`), read (list·download·editor / `drive_list`·`drive_read`·`drive_load`), update (editor·rename / `drive_write`·`drive_move`), delete (✕ / `drive_delete`).

File work runs in a thread (`asyncio.to_thread`), so moving big files doesn't stall the server. Change notifications from that thread are handed to the server loop to broadcast (at first this was missing, and `drive_upload` moved the file but raised "no running event loop").

## Web UI

- Top "드라이브" (Drive, `/#drive`): the whole drive. Path bar, upload (button·drag-and-drop, progress), new folder, new text file, edit (text files, ⌘/Ctrl+S saves), rename (new name, or a path starting with `/` to move), delete (asks once more), download, copy drive path·local path. Clicking a file name opens it in a new tab.
- Session detail "드라이브" tab (tmux and SDK): the same screen, starting in that session's folder.
- Attachments on the conversation/send tabs: see "Attaching files to a request" above.

## Files

| File | |
| --- | --- |
| `server/cardinal_server/drive.py` | path normalizing·guarding, listing, upload (streamed), text read/write, move, delete, local ↔ drive, attachment note |
| `server/cardinal_server/app.py` | `/api/drive*`, `/api/sessions/<name>/attachments`, session folder reconciling, change notifications |
| `server/cardinal_server/sessions.py` | folder on session creation, tmux `--add-dir=`, `attachments` on send |
| `server/cardinal_server/mcp_server.py` | `drive_*` tools, `attachments` on `session_new/send` |
| `web/src/components/DrivePanel.tsx` | drive explorer + editor + picker mode |
| `web/src/components/AttachBar.tsx` | request attachments (upload, pick from drive, drag-and-drop·paste) |

## Verified

On a scratch server (7889, `--sdk`) with haiku sessions:

- REST: listing, uploading the same name twice → `t1 (1).txt`, inline/attachment download, mkdir, move, moving a folder into itself refused, `/../etc`·`../..`·symlink pointing outside refused, deleting `/shared` refused, non-empty folder needs `recursive`, limit set to 1MB and a 2MB upload → 413 + no temp file left, text file create/overwrite blocked/read, reading binary → 400
- SDK session: send with an attachment → answered from the memo's contents. `drive_upload` (default move → gone from the working dir), `drive_load`, `drive_write → drive_read → drive_move → drive_delete → drive_list` all worked in order
- tmux session: with `--add-dir=` the first instruction (`--prompt`) still gets through, the attachment is read without a permission prompt, `drive_upload` works
- Web UI (Chrome): drive screen, entering folders, saving in the editor, sending a file from the conversation tab (session read it and answered), a session's `drive_write` showing up immediately in an open drive tab

## Notes

- The human REST API is guarded only by the server token (`CARDINAL_TOKEN`). The drive is a space shared by one person (or one team), so permissions aren't split per session: any session reads and writes the whole drive.
- Channel (Discord etc.) attachments are still saved to `~/.cardinal/inbox/<event>` as before (they don't go to the drive).
- Text editing is capped at 2MB. Use download/upload for bigger files.
