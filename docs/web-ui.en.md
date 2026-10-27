# Web UI

[한국어](web-ui.md) · Related: [server](server.en.md), [how the web terminal works](web-terminal.en.md), [SDK mode](sdk-mode.en.md)

A browser front end for Cardinal: `web/` (Vite + React + TypeScript). It uses only the Cardinal server's REST/WebSocket API, and **every option the server offers is available on screen** (see the mapping table).

## Running

```sh
cd web
pnpm install
pnpm build      # → web/dist, served by the Cardinal server at / (no server restart needed)
pnpm dev        # dev server http://localhost:5173; /api and /ws are proxied to the Cardinal server
```

- The server defaults to `http://127.0.0.1:7878`. To point the dev server elsewhere: `CARDINAL_URL=http://… pnpm dev`.
- To serve a build from another location, start the server with `CARDINAL_WEB_DIST=/path/dist`.
- Opening `/` before building shows a page with build instructions.

## Server features ↔ UI

| Server | Options | UI |
| --- | --- | --- |
| `GET /api/health` | channel status, session count, `sdk` | top chips (Discord off/connecting/ready/failed, SDK mode · live SDK sessions), every 10s. Default backend in the new session dialog |
| `GET /api/sessions` | `all` (include deleted) | left list, "삭제된 것도" |
| `POST /api/sessions` | `name`, `role`, `cwd`, `trust`, `prompt`, `args`, `routes[]`, `backend`, `sdk{…}` | every field of the "새 세션" dialog (`sdk`: everything except `setting_sources`) |
| `DELETE /api/sessions/<name>` | `purge` | "종료" / "종료 + 기록 삭제" |
| `POST …/send` | `text`, `wait`, `timeout_s`, `submit`, `now`, `force` | Send tab: wait for reply + max seconds, paste only (no Enter), inject now, force. SDK sessions have no paste-only, keys or 16KB limit |
| `POST …/keys` | any tmux keys | Send tab: common key buttons + free-form key input |
| `GET …/screen` | `lines` (scrollback) | Screen tab: scrollback choice, 2s auto refresh |
| `GET …/report` | phase, last human turn, tools | Result tab (optional tool calls) |
| `GET …/events` | `limit` | Hook events tab: 100/300/1000/5000 |
| `GET/POST …/routes`, `DELETE /api/routes/<id>` | `platform`, `channel`, `trigger`, `match`, `auto_reply` | Routes tab (list/add/delete), new-session dialog |
| `GET /api/events` | `limit` | Channel view: 20/50/200/500 |
| `POST /api/channel/inbound` | `content`, `channel`, `author`, `mentions_bot` | Channel view "넣기" + "봇 멘션" |
| `WS /ws/channel` message injection | `attachments` (base64) | file attachments on "넣기" (sent over the WebSocket when attached) |
| `POST /api/events/<id>/reply` | `text`, `files[]`, `session` | per-event "직접 답장" (files, sender session) |
| `WS /ws/term/<name>` | `cols`, `rows`, `readonly` | Terminal tab (auto size), "관전 모드" |
| `POST …/interrupt` (SDK) | | "중단" in the detail header and conversation tab |
| `POST …/restart` (SDK) | `resume`, `sdk{…}` | "다시 시작" in the detail header, "resume / new conversation" in the conversation tab (ended sessions), "restart with changed options" in the settings tab |
| `GET …/pending`, `POST …/pending/<id>` (SDK) | `answers`, `allow`, `message` | question/permission cards in the conversation tab, "답 기다리는 질문 n" in the header |
| `GET …/mcp`, `POST …/mcp/<server>` (SDK) | `reconnect` / `enable` / `disable` | MCP tab |
| `POST …/model`, `…/permission-mode` (SDK) | `model`, `mode` | settings tab "apply to this session now" |
| `GET …/context` (SDK) | | settings tab context usage |
| `GET …/turns` (SDK) | `limit` | past turns in the conversation tab (30 at a time, "load earlier turns") |
| `WS /ws/sdk/<name>` (SDK) | `hello`, `state`, `message`, `turn`, `pending(_done)`, `result` / sends `send`, REST if the socket is down | conversation tab, live |
| `WS /ws/events` | session list push | live list/state updates, reloads detail tabs |
| `WS /ws/channel` notifications | `event`, `delivery`, `reply` (local attachment bodies), `reply_saved` | live channel view, downloads for local reply attachments |
| Token (`CARDINAL_TOKEN`) | `?token=`, `Authorization: Bearer` | "토큰" button; the dialog opens automatically on 401 |

Every session field (identity key, backend, Cardinal tools (MCP / CLI), tmux, current claude session ID, working dir, creator session (master; also shown as `↳ master` in the list), transcript path, extra claude args, state/last hook event/tool, created time) is shown under "세션 정보" in the session detail.

## Screens

```
┌ top: Cardinal · [세션] [채널] [드라이브] ····· live ● · alive n · working n · Discord status · token ┐
├ left: [+ 새 세션] / session list (state dot, role, state, working dir) ┬ right: selected session or channel ┤
```

### Session list

Live via `/ws/events`. State dots: idle (green), working (orange, tool name), waiting for approval / for an answer on SDK (red), starting / interrupted by a human (blue), ended (grey). SDK sessions show `SDK` next to the name. "삭제된 것도" also shows DB records of purged sessions (not selectable).

### Session detail (tabs)

| Tab | What it does |
| --- | --- |
| 터미널 | attaches to the tmux screen. "관전 모드" ignores input and doesn't affect window size |
| 화면 | the tmux screen as text (no attach); scrollback lines, 2s auto refresh. Claude Code uses the alternate screen, so tmux keeps almost no scrollback → use the Result tab for the full conversation |
| 보내기 | message: wait for reply (max seconds; partial reply on timeout) / paste only / inject now / force. Shows the 16,000-byte limit (tmux). Keys: Enter, Esc (interrupt), ↑↓, accept trust (Down Enter), Ctrl+C, plus free-form keys |
| 결과 | current phase + the last human turn's instruction and full reply; optional tool calls; marks interrupted/in-progress turns; strips the `<pasted_content>` wrapper |
| 훅 이벤트 | hook event history (selectable count) |
| 라우트 | route list, add, delete |

The Result and Hook events tabs reload whenever the session list changes (`/ws/events`).

### SDK sessions

When the server runs with `--sdk` ([SDK mode](sdk-mode.en.md)), an "SDK 모드" chip shows at the top and the new session dialog defaults to SDK. Choosing SDK there replaces trust/claude args with the SDK options: permission mode, model, Claude in Chrome (follow global / on / off), extra system prompt, external MCP servers (JSON), strict / per-character streaming / auto resume on server start, and "고급 옵션" (fallback model, effort, allowed/disallowed tools, max turns/budget, question timeout, extra dirs, env). Bad JSON, relative paths and lines that aren't `KEY=VALUE` are caught before sending.

SDK session detail has different tabs: **conversation (대화) · send · result · hook events · MCP · settings (설정) · routes** (no terminal/screen). The header shows permission mode and model, "중단" and "다시 시작" buttons, and the number of questions waiting for an answer (click → conversation tab). "종료" can be restarted later; "종료 + 기록 삭제" marks it deleted, so it can't.

| Tab | What it does |
| --- | --- |
| Conversation | live over `/ws/sdk/<name>`. Past turns (DB `sdk_turns`) as bubbles: the instruction, n tool calls (expandable), the reply, time / duration / cost / interrupted / error. The current turn as it arrives: text, tool calls + results (failures in red), and with `partial` the text as it's generated (dashed bubble). Sent messages show dashed while waiting their turn. Follows to the bottom only if you're already there |
| Question card | AskUserQuestion: option buttons per question (with descriptions; `multiSelect` allows several, joined with `, `), free text (used instead of the choice when filled). "답하기" / "답 안 함 (decide yourself)" |
| Permission card | tool permission in non-auto modes like `default`: input JSON, optional deny reason, "허용" / "거부" |
| Input box | Enter sends, Shift+Enter for a newline (Enter during Hangul composition is ignored). Inject now / force. "중단" while working. When the session has ended, "resume / new conversation" replace the input |
| Send | same as tmux minus paste-only, keys and the byte limit. Use `wait` to get the reply back |
| Result | same as tmux + duration and cost, turns that ended in an error, number of waiting questions |
| MCP | per server: status (connected/failed/needs-auth/pending/disabled), scope, server info, error, tools (expandable). "다시 연결" and "켜기/끄기" for everything except cardinal |
| Settings | apply model / permission mode now (kept for later restarts). Context usage bar + tokens per category. The options form (filled with current values) with "resume restart" / "new conversation restart" / "reset". The saved options as JSON |

The settings form is filled with the values the server redacted (`***` in `env` and MCP `env`/`headers`). Leave them and restart, and the server uses the originals (only edited values change). Secrets never travel from the server to the browser (the `/ws/events` push is redacted too).

### Voice input (SDK conversation tab)

The 🎤 button above the input box: click to record, click again to stop. The audio is turned into text **inside the browser** with Whisper (transformers.js `@huggingface/transformers` 4.3.1) and appended to the input box. Only the text goes to the server, never the audio.

- Model (⚙): Whisper base (fast) / small / **large-v3-turbo (default, accurate)**. Uses WebGPU when available, WASM (CPU) otherwise, and picks files to match (turbo on WebGPU f16: q4f16, about 564MB). Downloaded once from Hugging Face and kept in the browser cache. "미리 받기" downloads ahead of time; it also downloads while you record
- Language: defaults to the browser language (ko-KR → Korean). "Auto" exists but in testing it turned Korean speech into an English sentence, so it's not recommended
- "인식되면 바로 보내기" (send on recognition): skip the input box and send to the session directly
- Recordings over 30s are recognized in overlapping 30s chunks; recording stops itself at 5 minutes
- Inference runs in a Web Worker (`web/src/asr/worker.ts`). The main bundle is unchanged (the ~550KB worker and ~27MB onnxruntime WASM load only on first use)
- The mic only opens in a secure context: `127.0.0.1`/`localhost` or https. Opened with `--host 0.0.0.0` and visited over http from another device, the button is disabled
- Measured (this Mac, Chrome, WebGPU f16, speech generated with macOS `say`): turbo Korean 3.7s → about 1.0s, exact ("안녕하세요. 오늘 회의 자료를 정리해서 요약해 주세요."); English 2.8s → 0.95s, exact. base: 0.86s, Korean differing only in a "?" and spacing. The real mic recording path (permission prompt) couldn't be covered by automated testing

### Drive / attachments

A file space shared by humans and sessions ([webdrive](drive.en.md)). The top "드라이브" (`/#drive`) shows the whole drive; the "드라이브" tab in session detail (tmux and SDK) starts in that session's folder (`/sessions/<name>`).

- Upload (button·drag-and-drop, progress), new folder, new/edit text file (⌘/Ctrl+S), rename (starting with `/` moves), delete (asks once more), download, copy drive path·local path. Clicking a file name opens it in a new tab.
- When a session runs `drive_upload`/`drive_write`, the folder being viewed refreshes right away via the `/ws/events` notification.
- Input box on the conversation and send tabs: pick with "📎 파일" (or drag-and-drop / paste) and it's uploaded straight to `/sessions/<name>/attachments/` and shown as a chip. "드라이브에서" (from drive) picks an existing file. On send, the server appends a note with drive path + local path after the instruction. Attachments alone are fine too.

### Channel

- For each received event: event ID, content, attachments (size, save failures), deliveries (pending/sent/failed + reason), replies (reply/auto reply, failure reason, attachment names).
- "직접 답장": text + files (up to 10, 10MB each) + sender session (for the record; also prevents a duplicate auto reply). Sent as a reply to the original message.
- Local channel injection: channel, author, content + bot mention + attachments. Without attachments it uses REST and shows the matched sessions right away; with attachments it goes over `/ws/channel` and the result shows up in the list.
- Local reply attachments have no body in the DB, so only those received over `/ws/channel` while the page is open can be downloaded ("⬇ file name").

### Token

If the server runs with `CARDINAL_TOKEN`, open the page once with `?token=…` (stored in this browser and removed from the address bar) or use the "토큰" button. A 401 from the API opens the dialog automatically. REST sends `Authorization: Bearer`; WebSockets use the `?token=` query. Static files need no token (nothing secret).

### Choosing a screen by URL

`/#s=<session name>` (session detail), `/#channel` (channel), `/#drive` (drive). The current view is reflected in the hash, so reload and bookmarks keep it.

## Files

| File | |
| --- | --- |
| `web/src/api.ts` | API client, token, WebSocket URLs, multipart replies, base64 attachments, 16KB limit |
| `web/src/types.ts` | server response types |
| `web/src/hooks.ts` | reconnecting JSON WebSocket subscription (`useJsonSocket`), one that also sends (`useSocket`, `/ws/sdk`), intervals |
| `web/src/App.tsx` | layout, live session list, token, URL hash |
| `web/src/components/SessionList.tsx` | session list |
| `web/src/components/CreateSession.tsx` | new session (backend choice) |
| `web/src/components/SdkOptionsFields.tsx` | SDK options form (shared by new session and settings tab), form ↔ options conversion and checks |
| `web/src/components/SdkPanels.tsx` | SDK: conversation (live, question/permission cards) / MCP / settings |
| `web/src/components/MicInput.tsx`, `web/src/asr/*` | voice input: mic recording, Whisper worker, model/language settings |
| `web/src/components/SessionView.tsx` | session detail, session info, tabs (per backend; terminal loaded on demand), interrupt / restart |
| `web/src/components/SessionPanels.tsx` | Screen / Send / Result / Hook events / Routes |
| `web/src/components/TerminalView.tsx` | xterm.js + `/ws/term` |
| `web/src/components/DrivePanel.tsx`, `AttachBar.tsx` | webdrive explorer·editor, request attachments |
| `web/src/components/ChannelPanel.tsx` | channel events, direct replies, local injection, local reply downloads |
| `web/src/styles.css` | light/dark, narrow screens |

## Verified

Driven end to end in a real Chrome (Playwright), with no browser console errors:

- terminal attach and output / Screen tab (scrollback choice) / session info
- send → reply "7" / paste only → Enter key → "5" / max 2s → "시간 초과 (partial reply)" / free-form key `Escape` → "사람이 중단함" / over 16KB disables the button with a notice
- Result · Hook events (count) · Routes (add: @mention + auto reply)
- new session (custom dir + auto trust) → idle
- Channel: local inject → auto reply "8" / bot-mention inject → mention route matched → auto reply / inject with attachment → session reads the file and answers / direct reply with a file → recorded + local reply attachment downloadable (content matches)
- light mode, mobile width (390px)

SDK session screens were also checked in a real Chrome (answering a question, streaming + interrupt, adding an MCP server and its status, restarting with redacted options, resuming after a server restart, permission deny/allow, tmux sessions on the same page). Details in [SDK mode → Verified](sdk-mode.en.md#verified).

## Notes

- Hangul takes two terminal cells. Without a matching monospace Hangul font (e.g. D2Coding) in the browser, it looks widely spaced.
- First load is about 290KB (89KB gzip); the terminal tab (xterm) loads about 330KB (84KB gzip) more when opened. With only SDK sessions, xterm is never loaded.
- Kill, and restarting a live session, ask through the browser's confirm dialog.
- Context usage categories come with Claude Code theme names (`promptBorder` etc.) as colors, which CSS can't use → the UI uses its own colors in order. "Free space" and deferred categories are left out of the bar.
- Subagent messages (with `parent_tool_use_id`) aren't shown in the conversation tab (main agent only).
- Route enable/disable (`enabled`) exists only as a DB column with no server API, so it's not in the UI (add/delete instead).
