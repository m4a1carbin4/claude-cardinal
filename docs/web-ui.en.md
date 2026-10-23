# Web UI

[한국어](web-ui.md) · Related: [server](server.en.md), [how the web terminal works](web-terminal.en.md)

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
| `GET /api/health` | channel status, session count | top chips (Discord off/connecting/ready/failed), every 10s |
| `GET /api/sessions` | `all` (include deleted) | left list, "삭제된 것도" |
| `POST /api/sessions` | `name`, `role`, `cwd`, `trust`, `prompt`, `args`, `routes[]` | every field of the "새 세션" dialog |
| `DELETE /api/sessions/<name>` | `purge` | "종료" / "종료 + 기록 삭제" |
| `POST …/send` | `text`, `wait`, `timeout_s`, `submit`, `now`, `force` | Send tab: wait for reply + max seconds, paste only (no Enter), inject now, force |
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
| `WS /ws/events` | session list push | live list/state updates, reloads detail tabs |
| `WS /ws/channel` notifications | `event`, `delivery`, `reply` (local attachment bodies), `reply_saved` | live channel view, downloads for local reply attachments |
| Token (`CARDINAL_TOKEN`) | `?token=`, `Authorization: Bearer` | "토큰" button; the dialog opens automatically on 401 |

Every session field (identity key, tmux, current claude session ID, working dir, creator session (master; also shown as `↳ master` in the list), transcript path, extra claude args, state/last hook event/tool, created time) is shown under "세션 정보" in the session detail.

## Screens

```
┌ top: Cardinal · [세션] [채널] ····· live ● · alive n · working n · Discord status · token ┐
├ left: [+ 새 세션] / session list (state dot, role, state, working dir) ┬ right: selected session or channel ┤
```

### Session list

Live via `/ws/events`. State dots: idle (green), working (orange, tool name), waiting for approval (red), starting / interrupted by a human (blue), ended (grey). "삭제된 것도" also shows DB records of purged sessions (not selectable).

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

### Channel

- For each received event: event ID, content, attachments (size, save failures), deliveries (pending/sent/failed + reason), replies (reply/auto reply, failure reason, attachment names).
- "직접 답장": text + files (up to 10, 10MB each) + sender session (for the record; also prevents a duplicate auto reply). Sent as a reply to the original message.
- Local channel injection: channel, author, content + bot mention + attachments. Without attachments it uses REST and shows the matched sessions right away; with attachments it goes over `/ws/channel` and the result shows up in the list.
- Local reply attachments have no body in the DB, so only those received over `/ws/channel` while the page is open can be downloaded ("⬇ file name").

### Token

If the server runs with `CARDINAL_TOKEN`, open the page once with `?token=…` (stored in this browser and removed from the address bar) or use the "토큰" button. A 401 from the API opens the dialog automatically. REST sends `Authorization: Bearer`; WebSockets use the `?token=` query. Static files need no token (nothing secret).

### Choosing a screen by URL

`/#s=<session name>` (session detail), `/#channel` (channel). The current view is reflected in the hash, so reload and bookmarks keep it.

## Files

| File | |
| --- | --- |
| `web/src/api.ts` | API client, token, WebSocket URLs, multipart replies, base64 attachments, 16KB limit |
| `web/src/types.ts` | server response types |
| `web/src/hooks.ts` | reconnecting JSON WebSocket subscription, intervals |
| `web/src/App.tsx` | layout, live session list, token, URL hash |
| `web/src/components/SessionList.tsx` | session list |
| `web/src/components/CreateSession.tsx` | new session |
| `web/src/components/SessionView.tsx` | session detail, session info, tabs (terminal loaded on demand) |
| `web/src/components/SessionPanels.tsx` | Screen / Send / Result / Hook events / Routes |
| `web/src/components/TerminalView.tsx` | xterm.js + `/ws/term` |
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

## Notes

- Hangul takes two terminal cells. Without a matching monospace Hangul font (e.g. D2Coding) in the browser, it looks widely spaced.
- First load is about 250KB (78KB gzip); the terminal tab (xterm) loads about 330KB (84KB gzip) more when opened.
- Route enable/disable (`enabled`) exists only as a DB column with no server API, so it's not in the UI (add/delete instead).
