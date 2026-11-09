# Admin session

[한국어](admin-session.md) · Related: [SDK mode](sdk-mode.en.md), [Cardinal MCP](mcp.en.md), [server](server.en.md)

**One master session** that looks after the whole Cardinal install. Every time the SDK-mode server (`cardinal-server --sdk`) starts, the server brings it up itself and continues **the same session ID and the same claude conversation**. You talk to it and have it manage sessions, routes and channels.

## How it starts

- Named `cardinal` (change with `CARDINAL_ADMIN`, `CARDINAL_ADMIN=0` turns it off). SDK mode only
- On the first start it creates the session row, and from then on **keeps using that one row** → neither the Cardinal session ID (`id`) nor the claude conversation ID (`claude_session_id`) changes
- It starts once the server accepts requests (same path as `resume_on_start`, since it has to attach to the Cardinal MCP)
- If an SDK session with that name already exists, it's turned into the admin and continued. If a tmux session uses the name, it only logs a warning and doesn't start
- Role `master`, working directory = the Cardinal repo, `sdk_options` has `admin: true`, `resume_on_start: true`
- If the conversation file (`~/.claude/projects/…/<ID>.jsonl`) is gone, it starts **a new conversation with the same ID** (ID kept). If resuming itself fails (corrupt file etc.), it starts with a new ID anyway (the admin should exist while the server runs)

## How it differs

| | Admin | Regular master |
| --- | --- | --- |
| Cardinal MCP | `/mcp/admin` (master tools + the admin tools below) | `/mcp/master` |
| System prompt | master prompt + admin prompt (repo/data locations, rules) | master prompt |
| Readable dirs | repo + drive + Cardinal data (`~/.cardinal`: DB, logs) | working dir + drive |
| Delete (`purge`) | no. Only kill; it comes back on the next server start | yes |
| Restart as a new conversation (`resume=false`) | no (continues the same conversation) | yes |
| `session_kill` from another session | no (humans only, via web UI/API) | masters can |
| Name | reserved. No other session can be created with it | |

Talking through a character: [stage](stage.en.md) (`/stage`).

The web UI shows an `admin` badge, `GET /api/health` has `admin: {name, state, alive}`, and session rows have `admin: true`.

## Admin tools (only on `/mcp/admin`)

| Tool | What it does |
| --- | --- |
| `session_restart` | bring an ended session back. SDK: `resume=true` (default) continues the conversation; tmux: only when tmux is gone, same conversation (`cardinal revive`) |
| `route_list` | channel routes (only one session's with `session`), each with its session name |
| `route_add` | add a route (`session`, `platform`, `channel`, `trigger`, `match`, `auto_reply`, `allow_bots`) |
| `route_delete` | delete a route (`route_id`) |
| `server_status` | server URL, SDK mode, channel connection states, session counts |
| `event_list` | recent channel events with delivery and reply results |

The master tools (create/send/wait/report/kill sessions, screen/keys, answer questions) and drive tools are there as usual.

`/mcp/admin` checks that the caller is the admin (name + `admin` option + SDK + master) and returns 403 otherwise.

## Because it lives long

- Long conversations get compacted by Claude Code. The prompt tells it to keep things worth remembering in the drive at `/sessions/cardinal/NOTES.md` and to reread them when starting work
- The prompt says to stop/restart the server (`launchctl`, `autostart.sh`) and to change, commit or push Cardinal's source **only when a human asks** (stopping the server stops itself too, and the server runs the checked-out code)
- Before killing other sessions or deleting routes it should check that a human asked for it

## Files

| File | |
| --- | --- |
| `server/cardinal_server/sdk.py` | `ADMIN_PROMPT`, `SdkManager.ensure_admin`, same-ID start when the conversation file is gone, blocks delete / new conversation |
| `server/cardinal_server/mcp_server.py` | `/mcp/admin`, admin tools, blocks `session_kill` on the admin |
| `server/cardinal_server/sessions.py` | reserved name, `restart` (shared by sdk/tmux) |
| `server/cardinal_server/config.py` | `CARDINAL_ADMIN` |
| `server/cardinal_server/app.py` | `admin` in `/api/health`, `admin` on session rows |

## Tested

With a server on a scratch home and port 7889:

- First start creates the `cardinal` row and starts it (`idle`); health shows `admin`
- `purge`, creating a session with the same name, restart with `resume=false` → all 400 with the reason
- Had the admin call `server_status`, `route_list`, `session_list` → all fine (`admin: true` in `session_list`)
- Server stop and start → same row ID and claude conversation ID, remembers the previous exchange
- A regular master's key: `/mcp/master` 200, `/mcp/admin` 403. With the admin's key, `tools/list` has the 6 extra admin tools
- Moved the conversation file away and restarted → "new conversation with the same ID" warning, came up with the same claude conversation ID and answered
