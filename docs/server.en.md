# Cardinal server (Python / FastAPI)

[한국어](server.md) · Related: [session system](session-system.en.md), [web terminal](web-terminal.en.md), [SDK mode](sdk-mode.en.md) (SDK sessions inside the server, no tmux)

The server that used to live inside the CLI (`cardinal serve`) is now a separate Python service in `server/`, so a message channel and a database can be attached.
This document follows "where a single request goes, in what order", with code locations and real records.

Contents

1. [Architecture](#1-architecture)
2. [Running and configuration](#2-running-and-configuration)
3. [Server startup sequence](#3-server-startup-sequence)
4. [Flow A: creating a session (with routes)](#4-flow-a-creating-a-session-with-routes)
5. [Flow B: files → DB collection](#5-flow-b-files--db-collection)
6. [Flow C: channel message in → delivery to a session](#6-flow-c-channel-message-in--delivery-to-a-session)
7. [Flow D: agent reply (`cardinal reply`)](#7-flow-d-agent-reply-cardinal-reply)
8. [Flow E: automatic reply (`auto_reply`)](#8-flow-e-automatic-reply-auto_reply)
9. [Flow F: web terminal / status push](#9-flow-f-web-terminal--status-push)
10. [Timeline from real records](#10-timeline-from-real-records)
11. [DB schema](#11-db-schema)
12. [Failures and edge cases](#12-failures-and-edge-cases)
13. [REST / WebSocket reference](#13-rest--websocket-reference)
14. [Discord bot setup](#14-discord-bot-setup)
15. [Tested / not done yet](#15-tested--not-done-yet)

---

## 1. Architecture

```
            Discord                                    browser / external systems
               │ (gateway WebSocket, always connected)       │ HTTP / WS
               ▼                                             ▼
 ┌──────────────────────────────── cardinal-server (FastAPI, one process) ──────────────────────────────┐
 │                                                                                                       │
 │  channel/discord_adapter ─┐                                                                           │
 │  channel/local_adapter ───┴─▶ router.handle ──▶ route matching ──▶ router._deliver ──▶ cli.send ──────┼──▶ cardinal CLI
 │                                    │                                                                  │
 │                                    └─▶ DB: channel_events / deliveries                                │
 │                                                                                                       │
 │  POST /api/events/<id>/reply ──▶ router.reply ──▶ adapter.send_reply ──▶ DB: replies                  │◀── cardinal reply
 │                                                                                                       │    (agent in a session)
 │  ingest.Ingestor ── watches ~/.cardinal/sessions ──▶ DB: sessions / session_events ──▶ /ws/events     │◀── hooks write files
 │                                                                                                       │
 │  terminal.bridge ── /ws/term/<name> ── `tmux attach` inside a pty                                      │
 │  REST /api/sessions/... ──▶ cli.* (new/kill/send/keys/screen/report)                                  │──▶ cardinal CLI
 └───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Three rules:

- **Session control logic lives only in the CLI.** The server just runs `cardinal ... --json` as a subprocess (`server/cardinal_server/cli.py`). tmux handling, hook injection and transcript parsing all stay on the TS side. The CLI works fully without the server.
- **For session records, files are the source and the DB is the collection.** The CLI writes `~/.cardinal/sessions/<name>/meta.json`; each hook writes only to its own dir `~/.cardinal/hooks/<instanceId>/`. The server only reads and collects into SQLite. Nothing is lost while the server is down; it catches up on start.
- **For channel records, the DB is the source.** Channel events, deliveries and replies are known only to the server, so they're written to the DB directly.

---

## 2. Running and configuration

```sh
cd server
uv sync
uv run cardinal-server                     # http://127.0.0.1:7878
DISCORD_TOKEN=xxx uv run cardinal-server   # with the Discord channel
```

| Env var | Default | |
| --- | --- | --- |
| `CARDINAL_HOME` | `~/.cardinal` | shared with the CLI; passed through when the server calls the CLI |
| `CARDINAL_WORKSPACE` | `~/.cardinal/workspace` | session working dir (used by the CLI) |
| `CARDINAL_DB` | `$CARDINAL_HOME/cardinal.db` | |
| `CARDINAL_HOST` / `CARDINAL_PORT` | `127.0.0.1` / `7878` | also `--host`, `--port` |
| `CARDINAL_TOKEN` | unset | if set, all HTTP/WS need `?token=` or `Authorization: Bearer` |
| `CARDINAL_CLI` | `<repo>/bin/cardinal` | |
| `DISCORD_TOKEN` | unset | unset → Discord off, local channel only. With a bad token an error is logged (`디스코드 연결 실패 …`) and only Discord is off. Check with `GET /api/health` |

`load()` in `config.py` reads these once into a frozen `Settings` dataclass.

---

## 3. Server startup sequence

`create_app()` in `app.py` builds the objects; `lifespan()` (`app.py:161`) starts and stops them.

```
Pre-start check (`__main__.py` → `running.py` `precheck`)
 · if the pid in ~/.cardinal/server.json is alive → print "카디널 서버가 이미 떠 있음: pid …", exit 1
 · if another process holds the port → "포트 … 를 다른 프로세스가 쓰고 있음 (--port 로 다른 포트 지정)", exit 1
 · a server.json left by a dead server (pid gone) is ignored and startup proceeds
 (previously it started without checking, and on the port clash it overwrote and then deleted the live server's server.json)

create_app()
 ├─ DB(settings.db_path)        ← creates the file if missing, applies the schema (CREATE TABLE IF NOT EXISTS), WAL mode
 ├─ Cli(settings)               ← env with CARDINAL_HOME baked in
 ├─ Hub() × 2                   ← /ws/events subscribers, /ws/channel subscribers
 ├─ Ingestor(on_change=sessions_changed)
 ├─ Router(publish=channel_hub.publish)
 └─ LocalAdapter → router.add_adapter

lifespan start
 1. await ingestor.sync()                  first sync; catch up on every hook event written while the server was down
 2. ingestor.run() as a background task    file-watch loop
 3. local.start(router.handle)
 4. if DISCORD_TOKEN: create DiscordAdapter, start → client.start(token) task (gateway login)
 5. write ~/.cardinal/server.json {url, token, pid}, mode 600
    (right before writing, check again whether another server came up → if so, fail startup without overwriting)
    → `cardinal reply` inside sessions reads this to find the server
 ── serving ──
lifespan end
 6. delete server.json if its pid is ours (don't delete if another server overwrote it)
 7. cancel the ingest task, close the Discord connection
```

Step 1 is awaited separately before `run()` so the DB is current before the first request, which route matching depends on.

---

## 4. Flow A: creating a session (with routes)

Request:

```http
POST /api/sessions
{"name":"helper","routes":[{"platform":"local","channel":"dev","trigger":"!ask","match":"prefix"}]}
```

```
client              app.create_session (app.py:250)       cardinal CLI (TS)                  tmux / claude
    │ POST ───────────▶│
    │                  │ validate pydantic SessionIn
    │                  │  (role ∈ worker|master, match ∈ prefix|contains|regex|mention …)
    │                  │ cli.new() ── subprocess ──────────▶│ `cardinal new helper --role worker --json`
    │                  │                                    │  check name, mint UUID, write meta/state(starting)
    │                  │                                    │  tmux new-session … claude --session-id … --settings <hooks>
    │                  │                                    │────────────────────────────────▶│ claude starts
    │                  │◀──── stdout JSON (getStatus) ───────│
    │                  │ await ingestor.sync()   ← put the new session in the DB right away
    │                  │ db.add_route(sid, …)    ← routes attach to the session identity (instanceId)
    │◀─ 201 {session + routes} │
```

Step by step:

1. **Validation** (`SessionIn` at `app.py:105`, `RouteIn` at `:97`): unknown `match` or `role` values are rejected here with 422.
2. **CLI call** (`Cli.new`, `cli.py:50`): `cardinal new <name> --role <role> [--prompt …] [--cwd …] [--trust] --json [-- claude args]`.
   - Run with `asyncio.create_subprocess_exec` (no shell). `CARDINAL_SESSION`/`CARDINAL_INSTANCE`/`CARDINAL_ROLE` are removed from the environment (API-created sessions have no parent). A non-zero exit turns the stderr `cardinal: …` message into a `CliError` → HTTP 400.
   - What the CLI does is as in [session system](session-system.en.md#creating-a-session): working dir (fixed workspace unless `cwd` is given), pre-assigned `--session-id`, hooks via `--settings`, role prompt (including "reply to external events with `cardinal reply`").
3. **Immediate sync** (`ingestor.sync()`): doesn't wait for the file watcher, so the response can carry the DB row.
4. **Save routes** (`add_route`, `db.py:241`): `routes.session_id` = session identity (instanceId). Because routes attach to the identity, not the name, a new session with the same name does not inherit old routes.
5. **Response**: the `sessions` row plus a `routes` array. State is usually `starting` at this point (claude hasn't fired `SessionStart` yet).

Actual response (from testing):

```json
{"name":"helper","state":"starting","alive":true,"routes":[{"id":1,"channel":"dev","trigger":"!ask","match":"prefix"}]}
```

About 4 seconds later claude fires `SessionStart` → state.json becomes `idle` → Flow B updates the DB to `idle`.

---

## 5. Flow B: files → DB collection

`ingest.py`. Hooks only write files and never talk to the server, so hooks don't fail when the server is down.

```
claude hook (dist/hook.js <hook dir>)        ~/.cardinal/hooks/<instanceId>/          Ingestor.run (ingest.py:237)
   │ overwrite state.json (tmp → rename) ────▶│ state.json                          │
   │ append a line to events.jsonl ──────────▶│ events.jsonl                         │
                                              │── watchfiles change (150ms debounce) ─▶│ _kick.set()
                                              │   (watches both sessions/ and hooks/)  │
                                                                                     │ sync()
                                                                                     │  ├ tmux list-sessions (set of live names)
                                                                                     │  ├ per sessions/*/meta.json → that instanceId's hook dir state.json → upsert_session
                                                                                     │  ├ read the hook dir's events.jsonl from offset → INSERT session_events
                                                                                     │  ├ sessions whose folder vanished → mark_deleted
                                                                                     │  └ if the session list snapshot changed → on_change()
                                                                                     │       → push {"type":"sessions",…} on /ws/events
                                                                                     │ also runs every 3s without changes (tmux dying externally)
```

`sync()` (`ingest.py:186`) in detail:

1. **tmux liveness** (`_tmux_sessions`): one `tmux list-sessions -F '#{session_name}'`. If there's no tmux server at all, it fails → empty set.
2. **Session upsert** (`db.py:154`): keyed by `meta.instanceId` (old sessions: `meta.claudeSessionId`). Only the hook dir that meta points to is read. The current claude session ID (`claudeSessionId` in `state.json`, changes on `/clear`) goes into the `claude_session_id` column.
   - Not in tmux → `state='ended'`, `alive=0`, regardless of state.json.
   - `ON CONFLICT DO UPDATE` refreshes only the state columns and resets `deleted_at=NULL`.
3. **Event catch-up** (`_tail_events`, `ingest.py:157`):
   - Look up how many bytes of this session were already read in `ingest_offsets`.
   - If the file is larger, read only the rest, and process **only up to the last `\n`** (a half-written line waits for the next round).
   - Parse each line into `session_events` and commit the new offset in **the same transaction** (`db.py:217`), so a crash causes neither duplicates nor gaps.
   - Esc interrupt correction (DB only, files untouched): the transcript's interrupt marker, and for interrupts before any reply, a `busy` state older than 3s whose bottom screen lines lack `esc to interrupt` on two consecutive checks (≥0.8s apart) → `idle`/`Interrupted`. So the web UI reflects it even if nobody runs the CLI (measured: 4s). Same rules as [session system](session-system.en.md#esc-interrupt--human-intervention).
4. **Deletion detection**: a session live in the DB with no folder gets `deleted_at`. Happens after `kill --purge` or when a name is re-created (the CLI deletes the old folder and writes a new one). The row itself is kept.
5. **Change notification**: serialize all `sessions` to JSON, compare with the previous one, and on difference call `on_change()` → push on `/ws/events`.

`sync()` runs one at a time behind an `asyncio.Lock` (the API's immediate sync and the watch loop can overlap).

Actual offsets after testing: `helper` read up to 3668 bytes, `auto` up to 733 bytes.

---

## 6. Flow C: channel message in → delivery to a session

### 6-1. Entry points

| Entry | Code | Produces |
| --- | --- | --- |
| Discord message | `on_message`, `discord_adapter.py:41` | `InboundMessage(platform="discord", …)` |
| `POST /api/channel/inbound` | `app.py:334` | `InboundMessage(platform="local", …)` |
| `{"type":"message",…}` on `/ws/channel` | `app.py:402` | `InboundMessage(platform="local", …)`, attachments as base64 |

What the Discord adapter fills in:

| Field | Value |
| --- | --- |
| `channel_id` | `str(message.channel.id)` |
| `channel_name` | channel name; `"dm"` for DMs, the thread name for threads |
| `guild` | server name (none for DMs) |
| `message_id` | used to find the original message when replying |
| `author` | `str(message.author)` |
| `mentions_bot` | whether the bot was mentioned |
| `attachments` | filename/size/type/URL + `read` (content downloaded only when needed) |

**All bot messages are ignored** (including its own). Otherwise a reply containing the trigger would loop forever.

### 6-2. `router.handle` (`router.py:129`)

```
InboundMessage
 1. mint evt_<8 hex> ID, INSERT channel_events (attachments still empty)
 2. db.active_routes()  ← enabled routes of live (alive=1), non-deleted sessions, JOINed with session name/state
 3. match_route(route, msg) for each route
 4. if anything matched and there are attachments → download → ~/.cardinal/inbox/<evt>/<file> → update channel_events.attachments
 5. for each matched route (once per session), start _deliver as a background task
 6. push {"type":"event", event, matched:[session names…]} on /ws/channel
 7. return (response body when it came in over HTTP)
```

- **Events are stored even when no route matches**, so you can later see what came in.
- **Attachments are downloaded only when something matched**; no point fetching files nobody will receive.
- **Delivery isn't awaited.** `_deliver` is started as a task and `handle` returns immediately. `auto_reply` can take minutes, and waiting would block the Discord event loop.

### 6-3. Route matching (`match_route`, `router.py:32`)

Checked in order; any miss rejects the route:

1. `platform`: `*` or equal to the message's platform.
2. `channel`: empty passes. Otherwise, with any leading `#` stripped, it must equal `channel_name` or `channel_id`.
3. By `match`:

| match | Condition | Body passed to the session |
| --- | --- | --- |
| `mention` | bot mentioned (trigger ignored) | body with `<@123…>` mention tags removed |
| (empty trigger) | always | original |
| `prefix` | `content.startswith(trigger)` | remainder after the trigger (`!ask hi` → `hi`) |
| `contains` | `trigger in content` | original |
| `regex` | `re.search(trigger, content)` | original; an invalid regex logs a warning and doesn't match |

Matching is case-sensitive.

### 6-4. Saving attachments (`router.py:108`)

- Files over 25MB are skipped and marked with `error`.
- Discord files are fetched with `attachment.read()`; local ones use the bytes already received.
- Filenames are sanitized (`[^\w.\-]` → `_`) to prevent path escapes.
- One failure doesn't stop delivery; failed files show up as `저장 실패: …` in the session message.

### 6-5. Delivery to the session (`_deliver`, `router.py:161`)

1. **State check**: delivery starts if the session state is `idle`/`busy`/`starting`. If `waiting` (approval), nothing is sent and `deliveries` gets `failed` (`세션 상태 waiting`).
   - `busy`/`starting`: the CLI waits until idle before sending (mid-turn input gets injected into the running turn; input into a dialog goes to the dialog). Events arriving right after a session is created now wait and go in this way; previously `starting` failed immediately.
   - If the session never becomes idle (stuck on the trust dialog), it fails after 600s.
2. **Build the message** (`format_delivery`, `router.py:64`). The actual text a session received:

   ```
   [cardinal:event evt_71363e3e] local #dev · tester
   트리거: !ask (prefix)
   ----
   첨부한 note.txt 에 적힌 숫자 두 개를 더한 값을 알려줘
   ----
   첨부 1개:
   - ~/.cardinal/inbox/evt_71363e3e/note.txt (0KB)
   답장: <repo>/bin/cardinal reply evt_71363e3e "<답장>" [--file <경로>]
   ```

   Externally supplied values (body, author, channel/server names, attachment paths) have **control characters removed** except tab and newline (`clean`). tmux doesn't filter pasted content, so things like `ESC[201~` pass through. With real claude, Claude Code filtered it and no escape was reproduced, but this is defense in depth.

   The leading `[cardinal:event <ID>]` is the agreed marker. The session system prompt says messages starting with it are external events and only `cardinal reply` reaches the channel.
3. **Record `pending`**: insert a `pending` row in `deliveries` and push `{"type":"delivery", …, "status":"pending"}` on `/ws/channel`.
4. **Session lock** (in the server): one `asyncio.Lock` per session. Deliveries to the same session go one at a time; with `auto_reply` the next event waits until the reply is done.
5. **Send** (`Cli.send`, `cli.py:64`): `cardinal send <name> - --queue-timeout 600 --json`, with the text **on stdin** (as an argument, a body starting with `-` would be parsed as an option).
   - Inside the CLI ([session system send](session-system.en.md#send)): session file lock → wait for idle if `busy` → refuse if `waiting` or on the trust dialog → (clear text an Esc interrupt restored into the input box) → paste → 200ms → `Enter` → confirm the hook state changed (received), retry `Enter` if not (up to 3 times, 3s each) (`src/session.ts:404-457`).
   - The server's subprocess timeout allows for the idle wait: `600 + 30`s.
6. **Record the result**: update the same row to `sent` if claude received it (`accepted`), or `failed` with a reason otherwise / on CLI error.
7. Push `{"type":"delivery", event_id, session, status}` on `/ws/channel`.

Why two locks: the CLI file lock works across processes (server, masters, humans); the server lock keeps event order inside the server and wraps a whole `auto_reply` cycle.

To claude, this text is **pasted input**. The prompt recorded by the `UserPromptSubmit` hook shows Claude Code wrapping it in a `<pasted_content …>` tag, so the agent sees it as "content the user pasted". The system prompt makes it follow through for now, but models tend to trust instructions inside pasted content less, so this may become a problem later (see [12](#12-failures-and-edge-cases)).

---

## 7. Flow D: agent reply (`cardinal reply`)

```
claude in a session (Bash tool)     cardinal CLI (src/reply.ts)                 server                                Discord
   │ cardinal reply evt_… "…" --file a.png
   │────────────────────────────▶│ 1. validate text/files
   │                             │ 2. find the server
   │                             │ 3. multipart POST /api/events/evt_…/reply ──▶│ app.reply (app.py:341)
   │                             │                                             │  UploadFile → OutboundFile
   │                             │                                             │ router.reply (router.py:203)
   │                             │                                             │  look up event → pick adapter
   │                             │                                             │  adapter.send_reply ─────────────▶│ reply to original message
   │                             │                                             │  INSERT replies (sent/failed)
   │                             │                                             │  /ws/channel {"type":"reply_saved"}
   │                             │◀──────── 200 {replies row} / 4xx·5xx {detail} │
   │◀── "sent reply to evt_…" / error + exit 1
```

CLI side (`src/reply.ts`):

1. **Validation** (`checkFiles`, `:27`): text or at least one file required. Each file must exist and be a regular file; max 10 files, 10MB each (Discord limit for unboosted servers). Failures stop here without touching the server.
2. **Finding the server** (`serverInfo`, `:17`): `CARDINAL_SERVER_URL` → else `~/.cardinal/server.json`. Token from `CARDINAL_TOKEN` → else the one in server.json. No file at all → "is the server running?" error.
3. **Send**: `FormData` with `text`, `session` (the `CARDINAL_SESSION` env var = session name) and `files` (repeated), plus `Authorization: Bearer <token>`.

Server side:

4. **Endpoint** (`app.py:341`): reads the form fields and turns each `UploadFile` into `OutboundFile(filename, data, content_type)`. The server checks again: no text and no files → 400; more than 10 files or a file over 10MB → 413 (so calling the API directly, bypassing the CLI, is also limited).
5. **`router.reply`** (`router.py:203`):
   - Look up the event in `channel_events`. Missing → `LookupError` → **404**.
   - Pick the adapter by the event's `platform`. Fails if that platform isn't connected (e.g. a Discord event after restarting without a token).
   - Resolve the session name to its ID for the record (the reply is sent even if it isn't found).
   - Call `adapter.send_reply` → `status='sent'` with the sent message IDs, or `status='failed'` with the error on exception.
   - **Record in `replies` either way** and push `reply_saved` on `/ws/channel`. On failure respond **502**.
6. **Discord send** (`discord_adapter.py:89`):
   - Channel from cache (`get_channel`), else the API (`fetch_channel`).
   - Text is split into 2000-char chunks **on line boundaries** (`split_text`, `base.py:53`); only a single line longer than 2000 is hard-cut.
   - Files are grouped 10 per message.
   - Number of messages = max(text chunks, file groups). The first is a **reply** to the original message (no mention ping); the rest are sent to the same channel.
7. **Local send** (`local_adapter.py:25`): pushes `{"type":"reply", event_id, channel, text, files:[{filename, content_type, data(base64)}]}` on `/ws/channel`.

Real record: the command the agent ran (`toolInput` of the `PreToolUse` hook):

```
'/Users/guest1/orca/claude-cardinal/bin/cardinal' reply evt_71363e3e "note.txt 에 적힌 숫자는 12 와 30 이고, 더하면 **42** 입니다."
```

---

## 8. Flow E: automatic reply (`auto_reply`)

With `auto_reply: true` on the route, `_deliver` takes a different path (`router.py:173`):

```
_deliver (holding the session lock)
 1. 'pending' in deliveries
 2. cli.send(name, text, wait=True, timeout_s=900)
      = cardinal send <name> - --queue-timeout 600 --wait --timeout 900 --json
        CLI: session lock → wait for idle → paste + Enter → confirm receipt → release lock
             → poll every 0.5s, accepting only states recorded after sentAt, until idle/waiting/ended
             → after Stop, up to 5s more until the transcript records the turn as end_turn (the final reply line is written after Stop)
        → {"sentAt", "accepted", "timedOut", "status", "last": full text of the turn this message created}
 3. delivery 'sent' if accepted, else 'failed'
    if timedOut: 'sent' + "턴이 900초 안에 안 끝나서 자동 답장 안 함" (it was delivered, so not a failure)
    if interrupted: 'sent' + "사람이 중단함 (Esc) → 자동 답장 안 함" (a turn a human stepped into is theirs)
 4. if sent, not timedOut, last is non-empty and **nobody** has replied to this event yet (replies.status='sent')
      → router.reply(…, source="auto")   ← same as steps 5–7 of Flow D
 5. release the session lock → next event
```

- `last` uses the same transcript parser to pick **the turn this message created** and returns all its assistant text blocks, so a next event starting a new turn right after can't steal it.
- If anyone already answered via `cardinal reply` (the receiving session or another one, e.g. a master), the auto reply is skipped → no duplicates. (Previously only the same session was checked, so a reply from another session got a second one.)
- If the turn stops at `waiting` (approval), the partial reply so far is sent.
- If the server restarts during the wait, the task is gone and no auto reply is sent. Server restarts are the operator's responsibility, so this is out of scope.

Real record (`auto` session, `contains "auto"`):

| Time | What happened |
| --- | --- |
| 08:55:51.091 | event `evt_59ec53c3` received, delivery recorded (this test predates serialization, so `sent` immediately; now `pending` → `sent` after the turn) |
| 08:55:51.431 | `UserPromptSubmit` (paste + Enter done) |
| 08:55:55.499 | `Stop` |
| 08:55:55.998 | auto reply `21` saved (`source=auto`), ~0.5s after Stop (the CLI polling interval) |

---

## 9. Flow F: web terminal / status push

### Web terminal `/ws/term/<name>` (`app.py:365` → `terminal.py:17`)

1. Check the token → find the session by name in the DB. Missing or `alive=0` → close with `4404`.
2. Create a pty with `ptyprocess` and run `tmux attach-session -t =<tmux name>` in it (spectator mode adds `-r -f ignore-size`).
3. `loop.add_reader(pty fd)` → on readable, `os.read` → queue → `ws.send_bytes` (raw bytes).
4. Incoming text JSON: `{"t":"i","d":…}` → `os.write(pty fd)`; `{"t":"r","c","r"}` → `setwinsize`.
5. When either side ends (browser closed / tmux detached), the other is cancelled and the tmux client in the pty is terminated = detach. The session keeps running.

The mechanism (two ptys, xterm.js, control codes) is in [web-terminal.en.md](web-terminal.en.md).

### Status push

| WebSocket | On connect | Afterwards |
| --- | --- | --- |
| `/ws/events` | one `{"type":"sessions","sessions":[…]}` | same shape whenever the session list changes (Flow B step 5) |
| `/ws/channel` | nothing | `event` (received + match result), `delivery`, `reply` (local reply content), `reply_saved` (every reply record) |

`Hub.publish` sends to subscribers **concurrently**, and drops any subscriber that can't be sent to within 2s. One slow client no longer holds up other subscribers or the router awaiting publish. (Previously it awaited them in order, so one slow client delayed everything.)

`/ws/events` pushes only when the session list actually changes; the ever-changing `updated_at` is excluded from the comparison (previously it pushed every 3s even with no change).

### Auth

- HTTP: `Depends(auth)` on every route (`app.py:205`). `?token=` or `Authorization: Bearer`; otherwise 401.
- WS: `ws_auth` (`app.py:209`) checks before accept and closes with `4401` on failure.
- Without `CARDINAL_TOKEN` everything passes (the default bind is 127.0.0.1).
- `?token=xxx` in uvicorn logs (`uvicorn.access`, `uvicorn.error`) is masked as `token=***` (`_RedactToken` filter, attached at startup). The web page passes the token in the query, so it used to end up in logs.

---

## 10. Timeline from real records

Exactly as recorded in the DB during local-channel testing. Event `evt_71363e3e` (`!ask` with an attachment):

| Time (UTC) | Source | Record |
| --- | --- | --- |
| 08:55:09.094 | sessions | `helper` created (API) |
| 08:55:13.271 | session_events #1 | `SessionStart` → idle |
| 08:55:20.146 | channel_events | `evt_76f03dd0` "그냥 잡담" → 0 matches, no delivery |
| 08:55:20.301 | channel_events | `evt_71363e3e` received, route 1 matched, `note.txt` (9 bytes) saved to inbox |
| 08:55:20.580 | deliveries | `helper` `sent` (~0.28s after receipt; 0.2s of that is the pre-Enter wait) |
| 08:55:20.639 | session_events #2 | `UserPromptSubmit` → busy |
| 08:55:26.355 | session_events #3 | `PreToolUse Bash` `cat …/inbox/evt_71363e3e/note.txt` |
| 08:55:28.661 | session_events #4 | `PostToolUse Bash` |
| 08:55:31.322 | session_events #5 | `PreToolUse Bash` `cardinal reply evt_71363e3e "…42…"` |
| 08:55:32.547 | replies | `tool` `sent` "note.txt 에 적힌 숫자는 12 와 30 이고, 더하면 **42** 입니다." |
| 08:55:32.595 | session_events #6 | `PostToolUse Bash` (reply command finished) |
| 08:55:34.830 | session_events #7 | `Stop` → idle |

Worth noting:

- The reply (`32.547`) goes out mid-turn, without waiting for the end of the turn (`Stop`, `34.830`). That's the difference from `auto_reply`.
- The ~6s from receipt to the agent's first tool call is model thinking time.

---

## 11. DB schema

Full DDL in `db.py:SCHEMA`. Column meanings:

### sessions

| Column | |
| --- | --- |
| `id` | session identity = instanceId (PK); old sessions use the initial claude session ID |
| `claude_session_id` | current claude session ID (changes on `/clear`) |
| `parent_id`, `parent_name` | the session that created this one (the master, for workers it launched); empty when created by a human/API |
| `name`, `role`, `tmux`, `cwd`, `claude_args`, `created_at` | from meta.json |
| `alive` | whether the tmux session exists (refreshed on every sync) |
| `state`, `state_at`, `last_event`, `detail`, `tool`, `transcript_path` | from state.json; state is `ended` if tmux is gone |
| `deleted_at` | when the record folder disappeared |
| `updated_at` | last upsert |

"Find by name" (`session_by_name`) = newest `created_at` among rows with `deleted_at IS NULL`.

### session_events / ingest_offsets

- `session_events`: `(session_id, at, event, tool, data)`. `data` is the raw events.jsonl line (prompt clipped to 2000 chars, tool input to 300, `promptId`, …).
- `ingest_offsets`: `(session_id, offset)` in bytes.

### routes

`(id, session_id, platform, channel, trigger, match, auto_reply, enabled, created_at)`. Actual rows from testing:

| id | session | platform | channel | trigger | match | auto_reply |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | helper | local | dev | `!ask` | prefix | 0 |
| 2 | auto | local | dev | `auto` | contains | 1 |

### channel_events / deliveries / replies

- `channel_events`: `(id evt_…, platform, channel_id, channel_name, guild, message_id, author, content, attachments JSON, received_at)`. Each `attachments` item: `{filename, size, content_type, url, local_path | error}`.
- `deliveries`: `(event_id, session_id, route_id, status pending|sent|failed, error, delivered_at)`. `delivered_at` is when the status last changed.
- `replies`: `(event_id, session_id, source tool|auto, text, files JSON, status, error, external_ids JSON, created_at)`.

`GET /api/events` returns `channel_events` newest first, each with its `deliveries` (session name JOINed) and `replies`.

---

## 12. Failures and edge cases

| Situation | Where | Result |
| --- | --- | --- |
| CLI error (duplicate name, unknown session, …) | `cli.py:run` | `CliError` → API 400 with the CLI's stderr message |
| CLI hangs | `cli.py:run` | killed after 60s by default; for `send`, 600s idle wait + `--wait` timeout + 30s → `CliError("… 시간 초과")` |
| `/send` with `wait` but no `timeout_s` | `app.py` `send` | waits 900s by default (previously the request never ended if the session got stuck) |
| `--wait` timeout | CLI `send` | not a failure: `timedOut: true` + partial reply; delivery recorded `sent` (previously `failed`) |
| Enter swallowed in a just-started session | CLI `send` | 1.5s settle after `SessionStart` + up to 3 Enters; still nothing → `accepted: false`, fail right away (previously `--wait` hung 900s and the session's later events sat `pending`) |
| Final reply not yet in the transcript right after `Stop` | CLI `send --wait` | waits up to 5s more until the turn is recorded as finished (previously `auto_reply` got an empty answer and sent nothing) |
| Bad `DISCORD_TOKEN` | Discord adapter | error log + `discord` in `/api/health` is `failed: …` (previously no trace; events just never came) |
| Slow WebSocket subscriber | `Hub.publish` | dropped after 2s; others unaffected |
| Route matches but session is `waiting` | `_deliver` | not sent, `deliveries.failed` "세션 상태 waiting" |
| Route matches but session is `starting` | `_deliver` → CLI | waits as `pending` until idle, then delivered |
| Session stuck on the working-dir trust dialog | CLI `send` | fails at once with "작업 폴더 신뢰 다이얼로그 대기 …" instead of waiting (`trust: true` at creation auto-accepts) |
| Route matches but session is dead | `active_routes` | excluded from candidates (no delivery record either) |
| Attachment over 25MB / download failure | `_save_attachments` | only that file gets `error`; delivery continues |
| `reply` with an unknown event ID | `router.reply` | 404, CLI exits 1 |
| No adapter for that platform | `router.reply` | `replies.failed` recorded + 502 |
| Reply API: no text and no files / 11+ files / file over 10MB | `app.py` `reply` | 400 / 413 / 413; files are read only up to limit+1 bytes to decide |
| Discord API error (missing permission, …) | `send_reply` | `replies.failed` + 502 |
| `cardinal reply` while the server is down | `serverInfo` / fetch | "no server info" or connection failure, exit 1. The reply is lost (no retry) |
| Hook events while the server is down | hooks only write files | nothing lost; caught up from the offset on next start |
| Server restarts during an `auto_reply` wait | `_bg` task | task gone, no auto reply. **Out of scope (server restarts are the operator's job)** |
| Several events arrive for one session at once | `_deliver` | delivered one by one (later ones wait as `pending`), each in its own turn. **Used to merge into one prompt → fixed** |
| Session busy for a long time | CLI `send` | waits up to 600s for idle, then fails (`failed` "대기 시간 초과") |
| A human interrupts with Esc (including before any reply) | state | treated as human intervention: state `idle`/`Interrupted`, a waiting `send --wait` ends at once with `interrupted: true`, no auto reply ([session system](session-system.en.md#esc-interrupt--human-intervention)) |
| Background-task notification turn | parser | not counted as a human turn; `report`/`last`/`--wait` show human turns only |
| Text over 16,000 bytes | CLI `send` | **note (tmux limit)**: rejected before reaching tmux, delivery `failed` with the reason. Save to a file and send the path |
| Another server started on the same HOME/port | `precheck` | refuses to start, exit 1; the live server's `server.json` is untouched |
| The send itself fails under `auto_reply` | `_deliver` | the `pending` row becomes `failed` (used to leave both `sent` and `failed` rows → fixed) |
| Agent trusts pasted instructions less | claude | no problems in testing so far; the delivery method would need to change if it happens |

---

## 13. REST / WebSocket reference

| Method | Path | Handling |
| --- | --- | --- |
| GET | `/` | web UI (`web/dist`; a build hint if not built). Static files like `/assets/…` need no token (nothing secret) |
| GET | `/api/sessions[?all=true]` | DB (`all` includes deleted) |
| POST | `/api/sessions` | Flow A. `{name, role, prompt, args, routes, cwd, trust}`; `cwd` must be absolute (else 400), `trust` auto-accepts the trust dialog |
| GET | `/api/sessions/<name>` | DB + routes |
| DELETE | `/api/sessions/<name>[?purge=true]` | `cardinal kill` → immediate sync |
| POST | `/api/sessions/<name>/send` | `cardinal send - [--wait]` `{text, wait, timeout_s, submit, force, now}`; waits for idle by default, `now` sends immediately |
| POST | `/api/sessions/<name>/keys` | `cardinal keys` `{keys: [...]}` |
| GET | `/api/sessions/<name>/screen?lines=` | `cardinal screen` |
| GET | `/api/sessions/<name>/report` | `cardinal report --json` |
| GET | `/api/sessions/<name>/events?limit=` | DB `session_events` |
| GET/POST | `/api/sessions/<name>/routes` | DB `routes` |
| DELETE | `/api/routes/<id>` | DB |
| GET | `/api/health` | `{ok, channels: {local, discord: off/connecting/ready/failed: …}, sessions}` |
| GET | `/api/events?limit=` | DB channel events + deliveries + replies |
| POST | `/api/channel/inbound` | Flow C (local) |
| POST | `/api/events/<id>/reply` | Flow D (multipart: text, session, files); max 10 files, 10MB each |
| WS | `/ws/term/<name>?cols=&rows=[&readonly=1]` | Flow F |
| WS | `/ws/events` | Flow F |
| WS | `/ws/channel` | Flow F + local input |

---

## 14. Discord bot setup

1. Create an app in the Developer Portal and get a Bot token.
2. Bot → Privileged Gateway Intents → enable **MESSAGE CONTENT** (otherwise `content` arrives empty, so triggers never match; only mentions work).
3. OAuth2 URL Generator: scope `bot`, permissions View Channels / Send Messages / Read Message History / Attach Files → invite to your server.
4. `DISCORD_TOKEN=... uv run cardinal-server`. It's connected when the log shows `디스코드 연결됨: <bot name>` and `discord` in `GET /api/health` is `ready`. A wrong token gives `failed: LoginFailure: …`.
5. Example routes:
   ```json
   {"name":"helper","routes":[
     {"platform":"discord","channel":"dev","trigger":"!ask","match":"prefix"},
     {"platform":"discord","match":"mention","auto_reply":true}
   ]}
   ```

---

## 15. Tested / not done yet

Tested (local channel, real claude sessions):

- Message without trigger → stored only, not delivered. `!ask` message → delivered only to the session with that route.
- Attachment → saved to inbox → agent read it with `cat` and answered via `cardinal reply` (`42`).
- Agent created a file and replied with it via `--file` (`hello.csv`).
- `auto_reply` (`contains`) → auto reply ~0.5s after Stop (`21`).
- After purge the DB still has the sessions (`deleted_at`), 14 hook events and 3 replies.
- Token auth (HTTP 401/200, WS reject/accept); `server.json` cleaned up on shutdown.
- Web terminal WebSocket: output, resize, input.
- `cardinal reply` errors: unknown event → "모르는 이벤트", missing file → "파일 없음".

Not yet:

- **Discord hasn't been run with a real bot** (no token). Only the adapter code exists.
- Out of scope: losing pending `auto_reply` waits on server restart, retrying failed `cardinal reply` (running the server is the user's responsibility).
- Routes can only be attached through the server API, not to workers a master creates via the CLI → add a `cardinal route` command if needed.
- Deliveries are pasted, so claude wraps them in `<pasted_content>`. Instructions are followed fine for now, but it's worth watching.
