# Cardinal MCP

[한국어](mcp.md) · Related: [server](server.en.md), [session system](session-system.en.md), [SDK mode](sdk-mode.en.md)

**When the Cardinal server is running, models inside sessions drive Cardinal only through MCP tools (`mcp__cardinal__*`).** tmux + Claude Code sessions and SDK sessions use the same MCP on the same server. The `cardinal` CLI stays, but it's for humans stepping in.

## Why the change

There used to be two paths:

- tmux sessions: the system prompt carried the CLI's absolute path and usage, and the model ran `cardinal new/send/reply …` through Bash
- SDK sessions: tools came from an in-process MCP server (`create_sdk_mcp_server`)

So the tools were implemented twice, and both relied on the model following the prompt. A worker could create sessions by calling the CLI, and the caller was known only through an environment variable (`CARDINAL_SESSION`).

Now:

- The tools live in one place, `server/cardinal_server/mcp_server.py`, shared by both backends
- The server decides the tool list per role: workers don't see master tools at all
- The caller is verified with a key on every request (not an environment variable)
- Usage lives in the tool descriptions, so the prompts got shorter

## Layout

```
                    cardinal-server (FastAPI)
                     └ /mcp  ── CardinalMcp.app
                          ├ /mcp/worker  → MCPServer "cardinal" (reply, session_list, session_send/wait/report → existing workers only, drive_*)
                          └ /mcp/master  → MCPServer "cardinal" (above + session_new/kill/screen/keys/answer, can call anyone)
                               ▲ checks X-Cardinal-Instance / X-Cardinal-Key (401 / 403)
              ┌────────────────┴────────────────┐
   tmux claude (started by the CLI)        SDK session (in the server)
   --mcp-config '{"mcpServers":{"cardinal":  mcp_servers={"cardinal":
     {"type":"http","url":…,"headers":…}}}'    {"type":"http","url":…,"headers":…}}
   --allowedTools mcp__cardinal            allowed_tools=[…, "mcp__cardinal"]
```

- Streamable HTTP, **stateless** (each request stands alone), so a server restart doesn't leave sessions with stale MCP session state.
- Both `/mcp/worker` and `/mcp/worker/` work (`Mount` wants a trailing `/`, so a small dispatcher sits in front).
- Mounted before the web UI catch-all (`/{path}`); otherwise `/mcp/...` falls into it (measured: 405).

## Tools

| Tool | Worker | Master | What it does |
| --- | :-: | :-: | --- |
| `reply(event_id, text, files[])` | ✓ | ✓ | reply to a channel event. files may be relative to the working dir; max 10, 10MB each |
| `session_list()` | ✓ | ✓ | session list (name, role, backend, state, working dir, creator) |
| `drive_list` `drive_read` `drive_write` `drive_move` `drive_delete` | ✓ | ✓ | work with webdrive files (list, read/write text, move, delete). A path without `/` is relative to my session folder → [webdrive](drive.en.md) |
| `drive_upload(src, path?, keep_source?)` / `drive_load(path, dest?)` | ✓ | ✓ | move local → drive / copy drive → local |
| `session_new(name, prompt?, role?, cwd?, backend?, wait?, timeout_s?, attachments?)` | | ✓ | create a worker. cwd and backend default to the caller's. Records the parent |
| `session_send(name, text, wait=true, timeout_s?, now?, attachments?)` | ✓* | ✓ | send an instruction (queued after the current work). `attachments`: drive files to hand over |
| `session_wait(name, timeout_s?)` | ✓* | ✓ | wait for the current work to finish, then report. Returns right away on a question/permission wait |
| `session_report(name)` | ✓* | ✓ | alive?, working/done/interrupted, last human turn in full, pending questions (SDK) |
| `session_kill(name, purge?)` | | ✓ | end a session |
| `session_screen(name, lines?)` | | ✓ | screen of a tmux session (check approval dialogs) |
| `session_keys(name, keys[])` | | ✓ | keys to a tmux session (handle dialogs) |
| `session_answer(name, pending_id, answers?, allow?, message?)` | | ✓ | answer an SDK session's question/permission |

- send/wait/kill/keys on yourself are refused.
- **Worker rules (✓\*)**: workers can't create sessions (no `session_new`). Instead they can hand work to **existing workers** with `session_send`/`session_wait`/`session_report` and get the result back. Calling a master or an unknown session is refused (`워커는 마스터를 부를 수 없음` = workers can't call masters, `모르는 세션 … 워커는 새 세션을 못 만듦` = unknown session, workers can't create sessions). Masters can call anyone.
- **Deadlock guard**: the server tracks who is waiting on whom (`session_send wait=true`, `session_wait`) and refuses a wait that would loop back to the caller. E.g. w1 calls w2 with wait, and inside that turn w2 sends to w1 with wait: w1's turn can't end, so both would hang until timeout → `교착: …` (deadlock) error. `wait=false` isn't blocked.
- Waiting tools (`session_send wait`, `session_wait`, `session_new wait`) cap at 3600s. The session side's MCP timeout is raised with `MCP_TOOL_TIMEOUT=3700000` (ms) (tmux via env, SDK via `env`).
- All tools go through the server's `Sessions` (backend dispatch), so a tmux master can create SDK workers and an SDK master tmux workers.

## Who's calling

- Server secret: `~/.cardinal/mcp.key` (created on first server start, 0600)
- Session key: `HMAC-SHA256(secret, instanceId)`, sent as `X-Cardinal-Instance: <instanceId>` and `X-Cardinal-Key: <key>`
- The server recomputes and compares the key on every request, then looks up the session row (syncing once more if a just-started tmux session isn't in the DB yet). Deleted session → 401; a worker calling `/mcp/master` → 403.
- No per-session token has to be stored, and the CLI can derive the key from the same file.
- The same OS user can read the key file. This decides "which session is calling, with which role"; it isn't a security boundary within one user.
- Separate from `CARDINAL_TOKEN` (web/API token). `/mcp` only takes session keys.

## Attaching it to sessions

### tmux sessions (`cardinal new`)

`mcpAttach()` in `src/session.ts`:

1. Server URL: `CARDINAL_SERVER_URL` (set by the server when it calls the CLI) → else `~/.cardinal/server.json`
2. Attach if `~/.cardinal/mcp.key` exists and `/api/health` answers within 1.5s (200/401)
3. Put `--mcp-config <JSON> --allowedTools mcp__cardinal` early in the claude args (both take multiple values, so at the end they'd swallow the initial prompt)
4. Use the MCP system prompt (below), write `"mcp": true` to `meta.json`, set env `MCP_TOOL_TIMEOUT=3700000`

With no server, or with `--no-mcp`, it's the old way: the CLI prompt and `mcp: false`. That's for people using only the CLI without a server.

When the server creates a session from a master tool, it passes the parent to the CLI via env `CARDINAL_PARENT_NAME` / `CARDINAL_PARENT_ID` (an SDK master has no meta file, so env is the only way). Before, tmux workers created by an SDK master lost their parent record.

### SDK sessions

`_build_options()` in `sdk.py` puts the same HTTP config into `mcp_servers["cardinal"]` (`mcp_server.mcp_config()`). The in-process MCP server is gone.

`resume_on_start` sessions start only once the server is accepting requests (`resume_when_serving`). During lifespan startup `/mcp` isn't served yet, so starting them then would fail to connect the Cardinal tools.

### Prompts

Prompts for MCP sessions (tmux: `MCP_*_PROMPT` in `src/session.ts`, SDK: `sdk.py`; same content):

- Common: "drive Cardinal only via `mcp__cardinal__*`; the CLI is for humans, don't call it through Bash"; `[cardinal:event <ID>]` marks an external event and replies only arrive via `mcp__cardinal__reply`
- Worker: can't create sessions; hands work to existing workers with `session_send`/`session_wait`/`session_report` (not masters). Can read/write other sessions' drive folders
- Master: `session_new` workers instead of built-in subagents, `session_send`/`session_wait`/`session_report`, when stuck `session_screen`+`session_keys` (tmux) / `session_answer` (SDK), `session_kill`

The reply hint at the end of channel deliveries matches the session: sessions with `sessions.mcp` (SDK always) get `mcp__cardinal__reply`, others `cardinal reply …`.

## When the server restarts

- **tmux claude doesn't reconnect a dropped MCP server by itself** (measured: after a server restart the tools stay gone, and asking again just says "not connected").
- So once the server is accepting requests, it runs `cardinal mcp-reconnect <name>` for each live tmux session with `mcp`:
  - queues on the same session lock as send and waits for current work to finish
  - types `/mcp reconnect cardinal` + Enter (works directly, no menu; measured)
  - succeeds when a new "Successfully reconnected to cardinal" appears on screen
- SDK sessions end and restart with the server, so they reconnect anyway.
- tmux sessions created while the server was down stay in CLI mode (`mcp: false`); they don't switch to MCP later.

## Shutdown

- No server→session notification stream (`GET` SSE); `GET` gets 405.
  - Left open, the claude processes keep holding those connections. Uvicorn then waits for them on shutdown and never reaches SDK session cleanup (lifespan shutdown). Measured: still not exited minutes after SIGTERM. The SDK claudes hold the connection, and stopping those claudes is exactly what lifespan shutdown does, so they wait on each other.
- `timeout_graceful_shutdown=5`: long MCP calls (`session_wait` etc.) or POST streams clients keep open are cut after 5s and cleanup proceeds. Shutdown now takes about 6s.

## Verified

On a scratch server (`--sdk`, haiku model):

- `/mcp/worker`, `/mcp/worker/`, `/mcp/master` without a key → 401, unknown path → 404. With an MCP client: worker key → 2 tools; the same key on `/mcp/master` → 403
- tmux worker created via the API: `meta.mcp=true`, called `mcp__cardinal__session_list` without a permission prompt
- tmux master used `session_new` to create a tmux worker and an SDK worker, collected their answers ("apple", "banana") with `wait`; both `parent=tm1`
- SDK master created a tmux worker, then `session_send(wait=false)` → `session_wait` → `session_report` → `session_kill(purge)`; worker `parent=sm1`
- local channel event → tmux worker replied "5" via `mcp__cardinal__reply` (`source: tool`)
- `cardinal new` without a server → `mcp: false` (CLI mode) / with a server → `true`, `--no-mcp` → `false`
- Server restart: the `resume_on_start` SDK master came back with Cardinal MCP connected (10 tools); 3 tmux sessions got an automatic `/mcp reconnect` and could call tools again
- Shutdown: before blocking `GET`, still not exited minutes after SIGTERM (cause above) → after, 6s

## Notes

- While the server is down, tmux sessions calling Cardinal tools fail (connection refused). They reattach as above once it's back.
- A session whose MCP connection failed at startup (e.g. the server misbehaved then) reattaches on the next server restart's `mcp-reconnect`, or a human runs `cardinal mcp-reconnect <name>`.
- haiku sometimes gets tool arguments wrong (left out `backend` and got an SDK worker; `message` instead of `text`). It reads the error and fixes it.
- The SDK warning `CanUseToolShadowedWarning: can_use_tool will not be invoked for: mcp__cardinal` is intended (Cardinal tools aren't gated).
- Not tried yet: an actual `session_wait` over 10 minutes, a real Discord bot.
