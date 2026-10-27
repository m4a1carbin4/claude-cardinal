# SDK mode

[한국어](sdk-mode.md) · Related: [server](server.en.md), [session system](session-system.en.md)

Instead of tmux + the Claude Code TUI, this mode **runs sessions directly inside the server process with the Claude Agent SDK (`claude-agent-sdk`, Python)**. Messages go in and out as data (no screen scraping, no key presses), which suits programs such as speech recognition/synthesis or motion.

- Sessions live with the server. When the server stops they end; `restart` brings them back and continues the conversation (`resume_on_start` does it automatically on server start)
- Not handled by the CLI (`cardinal ...`). Created, driven and read **only through FastAPI (REST + WebSocket)**
- Channels (Discord, local) and routes are **the same ones** tmux sessions use. Delivery, auto reply and direct replies all work
- Default permission mode is `auto`. Questions (AskUserQuestion) and permission checks are handed to a human and answered through the API

## Turning it on

```sh
cd server && uv run cardinal-server --sdk      # or CARDINAL_SDK=1
./launch.sh --sdk                              # server + web UI
```

With `--sdk`, new sessions default to the `sdk` backend. tmux sessions still work (`"backend": "tmux"`). A server started without `--sdk` can't create SDK sessions (old records can still be read and cleaned up). Check `sdk.enabled` in `GET /api/health`.

It uses this machine's Claude Code login (the SDK ships its own claude CLI).

## Creating a session

```http
POST /api/sessions
{
  "name": "voice",
  "role": "worker",                 // master adds guidance for the worker tools
  "cwd": "/abs/path",               // default: fixed workspace (~/.cardinal/workspace)
  "prompt": "first instruction (optional)",
  "backend": "sdk",                 // can be omitted on a --sdk server
  "routes": [{"platform": "local", "channel": "voice", "match": "prefix", "trigger": "!v", "auto_reply": true}],
  "sdk": {
    "permission_mode": "auto",      // default | acceptEdits | plan | dontAsk | bypassPermissions | auto
    "model": "sonnet", "fallback_model": null, "effort": null,
    "append_prompt": "extra system prompt",
    "mcp_servers": {
      "tts": {"type": "stdio", "command": "/usr/bin/python3", "args": ["tts_mcp.py"], "env": {"KEY": "..."}},
      "web": {"type": "http", "url": "https://...", "headers": {"Authorization": "Bearer ..."}}
    },
    "strict_mcp_config": false,     // true: only the mcp_servers above (+ cardinal); no user/project/claude.ai connector/plugin MCP
    "allowed_tools": [], "disallowed_tools": [], "add_dirs": [], "env": {},
    "partial": false,               // true: token-level StreamEvents on /ws/sdk (for TTS)
    "max_turns": null, "max_budget_usd": null, "setting_sources": null,
    "question_timeout_s": null,     // no answer within this time → "decide yourself and continue"
    "resume_on_start": false        // continue automatically when the server restarts
  }
}
```

- Name rules match tmux (letters/digits/-/_, 48 chars). Names are shared across backends: a name used by a tmux session (including its records) can't be used for SDK, and a live SDK session's name can't be used for tmux. An ended session's name is taken over; the old record stays, marked deleted.
- In session list/detail, values of `sdk_options.env` and MCP `env`/`headers` are shown as `***` (the DB keeps the originals because restart needs them).
- A new session is `idle` in about 0.7s (no trust dialog).

## Shared API (same as tmux sessions)

| API | For SDK sessions |
| --- | --- |
| `GET /api/sessions`, `GET /api/sessions/<name>` | `backend: "sdk"`; detail also has `pending` (questions waiting for answers) |
| `POST …/send` | `text`, `wait`, `timeout_s`, `now`, `force` as before. `submit: false` (paste only) is 400 (there's no input box) |
| `GET …/report` | same shape (`status`, `phase`, `turn`) + `pending` |
| `GET …/events` | hook event history (from SDK hook callbacks) + `Result`, `Question`, `Answered`, `SessionStart/End` |
| `DELETE /api/sessions/<name>?purge=` | end the session; purge marks it deleted |
| routes, channels, `POST /api/events/<id>/reply` | unchanged |
| `…/screen`, `…/keys`, `/ws/term` | tmux only → 400 / 4400 |

The send rules match tmux: one at a time per session, and if it's working, wait for idle before sending. Sending mid-turn makes the SDK fold the message into the running turn too, merging the replies (measured). `now: true` injects without waiting (you get that turn's result). While waiting for a question/permission answer (`waiting`), sends are rejected without `force`.

`wait: true` returns `{sentAt, accepted, timedOut, interrupted, status, last}`. `last` is the full text of the turn this message created. Unlike tmux it keeps waiting through questions until the turn ends (a question is part of the turn).

## SDK-only API

| API | What it does |
| --- | --- |
| `POST …/interrupt` | stop the running turn (tmux Esc). Pending questions are released as denied. The turn is `interrupted`; state `idle`/`Interrupted` |
| `POST …/restart` `{resume: true, sdk: {...}}` | start again; by default continues the last conversation. `sdk` takes only the options to change (e.g. add an MCP server) |
| `GET …/pending` | questions/permission checks waiting for an answer |
| `POST …/pending/<id>` | answer. Question: `{"answers": {"question text": "chosen label or free text"}}`. Permission: `{"allow": true}` / `{"allow": false, "message": "why"}` (+ `updated_input`). `allow: false` on a question means "no answer, decide yourself" |
| `GET …/mcp` | MCP server status (connected/failed/needs auth, tool list) |
| `POST …/mcp/<server>` `{action}` | `reconnect` / `enable` / `disable` |
| `POST …/model` `{model}` | change model (kept for later restarts) |
| `POST …/permission-mode` `{mode}` | change permission mode (kept) |
| `GET …/context` | context usage (same data as `/context`) |
| `GET …/turns?limit=` | turn history (DB `sdk_turns`). `origin`: human (sent) / agent (background task notifications etc.) |

## Live connection `/ws/sdk/<name>`

Where programs attach. On connect you get `hello` (session row, status, pending, report), then everything that happens in the session.

Received:

| type | content |
| --- | --- |
| `state` | `state`, `event`, `detail`, `tool`, `alive` (on every change) |
| `message` | raw SDK message as JSON (`message.type`: `AssistantMessage`, `UserMessage`, `SystemMessage`, `ResultMessage`, `StreamEvent` (with partial), `TaskStartedMessage` …) |
| `turn` | a turn finished (`prompt`, `texts`, `tools`, `complete`, `interrupted`, `result`) |
| `pending` / `pending_done` | a question/permission check appeared / was resolved |
| `result` | result of a command you sent (matched by `id`) |

Sent (`id` is your own request ID):

```json
{"type": "send", "id": "a1", "text": "...", "wait": true, "now": false, "force": false, "timeout_s": 120}
{"type": "interrupt", "id": "a2"}
{"type": "answer", "id": "a3", "pending_id": "q_1234abcd", "answers": {"question": "answer"}}
```

- If a subscriber's queue overflows (slow client), only that subscriber is dropped; the session isn't blocked.
- If the connection drops, sent messages still run in the session (only the result is discarded).
- With `partial: true`, text arrives as it's generated via `StreamEvent` `content_block_delta`/`text_delta` → straight into TTS.

## Cardinal tools (`mcp__cardinal__*`)

SDK sessions get an in-process MCP server `cardinal` (allowed without asking). No need to call the `cardinal` CLI through Bash.

| Tool | |
| --- | --- |
| `reply(event_id, text, files[])` | reply to a channel event (files are local paths, up to 10 × 10MB, relative to the working dir) |
| `session_list()` | session list |
| `session_new(name, prompt, role, cwd, backend, wait, timeout_s)` | create a worker. cwd defaults to this session's folder, backend to sdk. The parent (`parent_name`) is recorded |
| `session_send(name, text, wait, timeout_s)` | send an instruction (tmux sessions too) |
| `session_report(name)` | result report |
| `session_kill(name, purge)` | clean up |

Delivered messages (`[cardinal:event …]`) point SDK sessions to `mcp__cardinal__reply`. `CARDINAL_SERVER_URL` and `bin/` on `PATH` are also set, so `cardinal reply` from Bash works too.

## How it works inside

`server/cardinal_server/sdk.py`:

- One `SdkSession` = one `ClaudeSDKClient` + one task that keeps reading `receive_messages()`.
  - Turn start: the `SystemMessage(init)` sent on every query, or the `UserPromptSubmit` hook → the turn is `accepted`
  - Turn end: `ResultMessage`. `terminal_reason` `aborted_*` means interrupted. `origin.kind == "task-notification"` means a turn we didn't send (agent)
  - Text/tools: only the main agent's `AssistantMessage` (subagent ones carry `parent_tool_use_id` and are skipped)
  - State: busy (in a turn; tool name on `PreToolUse`) / waiting (something pending) / idle / ended (process ended or failed)
- Questions arrive through `can_use_tool` (AskUserQuestion goes there even in auto mode, measured). Held as `Pending`; on answer → `PermissionResultAllow(updated_input={...input, "answers": ...})`.
- Hooks: `PreToolUse`, `PostToolUse(Failure)`, `UserPromptSubmit`, `Stop`, `Subagent*`, `PreCompact`, `Notification`, `PermissionRequest` callbacks → `session_events`.
- System prompt: Claude Code preset + Cardinal role prompt + `append_prompt`.
- A new conversation starts with a preset `session_id`; restart uses `resume=<last claude session ID>`.
- `server/cardinal_server/sessions.py` (`Sessions`) picks the backend. The router, API and master tools all go through it.
- DB: `sessions.backend` (`tmux`|`sdk`), `sessions.sdk_options` (JSON), `sdk_turns`. The ingester only handles tmux sessions (SDK sessions have no files and must not be taken as deleted).

## Verified

Run for real against a scratch server (`--sdk`, haiku model):

- create 0.7s → idle, send → "pong 7" in 1.1s, report has the same shape as tmux
- Question: AskUserQuestion → pending (`waiting`) → answered over `/ws/sdk` → "chose Mango". A message sent during the question ran as its own turn after that one ended
- 3 simultaneous sends → 3 separate turns, each with its own answer
- interrupt during Bash `sleep 30` → immediately `interrupted`, next send fine
- Channel: local event → delivery `sent` → auto reply / agent replied with text + file (note.txt) via `mcp__cardinal__reply`; no duplicate auto reply
- An SDK master created a worker with `session_new` and collected its answer; worker `parent=m1`, same folder
- After restart (resume) it remembered the earlier conversation; after a server restart → `ended` → restart kept the memory; a `resume_on_start` session came back on server start
- External MCP (stdio) connected → tool call "zebra-15", disable/enable/reconnect; with `strict_mcp_config` only that server + cardinal
- claude process killed with -9 → immediately `ended` (with reason), sends rejected, restart recovered
- `partial` → `StreamEvent` text chunks received
- tmux sessions on the same server still fine; name conflicts and tmux-only APIs rejected; a server without `--sdk` refuses SDK creation

## Not done yet

- Web UI (SDK screens: answering pending items, MCP status, stream). The current UI shows list/send/result/routes, but terminal/screen tabs don't apply
- Not tried with a real Discord bot (verified on the local channel; same router)
- Long runs with permission modes other than auto, image input (streaming input blocks), showing subagent messages separately
