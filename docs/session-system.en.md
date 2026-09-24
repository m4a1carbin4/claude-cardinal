# tmux-based Claude session system

[한국어](session-system.md)

Groundwork before Cardinal proper. One Claude Code session = one tmux session, driven from the CLI, a WebSocket server, or another Claude session.

## Overview

```
 human (terminal)      browser / external         another claude session (master)
      │                      │                              │
  cardinal CLI       cardinal serve (HTTP/WS)      cardinal CLI (via Bash tool)
      └──────────┬───────────┴──────────────────────────────┘
                 ▼
          src/session.ts   ← shared create / query / control logic
            │         │
      tmux commands   ~/.cardinal/sessions/<name>/
            │         ▲   meta.json · state.json · events.jsonl
            ▼         │
   tmux session cardinal-<name>
     └─ claude (--session-id, --settings hooks) ── hooks → dist/hook.js ─┘
```

The CLI talks to tmux and the state files directly; no server needed. The server just exposes the same logic over HTTP/WS.

## Files

| File | Role |
| --- | --- |
| `src/paths.ts` | Path constants. `CARDINAL_HOME` (default `~/.cardinal`), tmux prefix `cardinal-` |
| `src/tmux.ts` | Thin tmux wrapper (has/list/kill, capture-pane, send-keys, paste) |
| `src/store.ts` | Read/write session record files |
| `src/hook.ts` | Claude Code hook. Turns hook events into session state |
| `src/session.ts` | Create, status, send/keys/wait, report, kill |
| `src/transcript.ts` | Parses the transcript (jsonl) into turns |
| `src/server.ts` | HTTP REST + WebSockets (terminal, state events) |
| `src/cli.ts` | The `cardinal` command |
| `public/index.html` | Web terminal (xterm.js) |
| `bin/cardinal` | CLI wrapper script |

## Creating a session

`cardinal new <name>` does roughly this:

0. The working directory is always fixed: `$CARDINAL_WORKSPACE` (default `~/.cardinal/workspace`). Created if missing, used by its realpath.
1. Validate the name (`[A-Za-z0-9][A-Za-z0-9_-]{0,47}`); fail if the tmux session already exists.
2. Generate a UUID and use it as the claude session ID, so Cardinal knows the ID up front.
3. Remove any leftover record dir for that name, write `meta.json` and `state.json (starting)`.
4. Launch tmux:
   ```
   tmux new-session -d -s cardinal-<name> -c <workspace> -x 200 -y 50 \
     -e CARDINAL_SESSION=<name> -e CARDINAL_ROLE=<role> -e CARDINAL_HOME=... -e PATH=<repo>/bin:$PATH \
     -- claude --session-id <uuid> --name <name> --settings '<hooks JSON>' \
               --append-system-prompt '<role prompt>' [claude args...] [initial prompt]
   ```
5. Set `window-size latest` so the most recently active client decides the window size.

When claude exits, the tmux session goes away with it.

### Why a fixed workspace

claude writes transcripts to `~/.claude/projects/<workspace path with every non-alphanumeric char replaced by '-'>/<session ID>.jsonl`
(under `CLAUDE_CONFIG_DIR` if set). Since the workspace is fixed and Cardinal picks the session ID,
the transcript path can be computed directly, without hooks (`transcriptPath()` in `src/paths.ts`), even after the session is gone.
As a bonus, the trust dialog only has to be accepted once for that folder.

### Hook injection

Hooks are injected via `--settings`, so the user's settings files are untouched (they merge with existing hooks). Registered events:
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`.
Command is `node <repo>/dist/hook.js`, 10s timeout.

The hook does nothing without `CARDINAL_SESSION`. It **never writes to stdout** (SessionStart/UserPromptSubmit output gets injected into claude's context) and always exits 0, even on error.

### Role prompts

- Common: "you are session `<name>` launched by Cardinal, level `<role>`", plus the absolute CLI path.
- Master only: when splitting work, spawn workers with `cardinal new ... --wait` instead of built-in subagents/workflows, unless the user asks otherwise. Includes send/ls/status/report/screen/keys/kill usage.

Why the absolute CLI path: claude's Bash tool rebuilds PATH from the user's shell profile, so tmux `-e PATH` doesn't survive. In testing, the master couldn't find `cardinal` until this was fixed.

## State

| State | Meaning | Set by |
| --- | --- | --- |
| `starting` | tmux is up, claude not ready yet (e.g. trust dialog) | Cardinal on create |
| `idle` | waiting for input | `SessionStart`, `Stop`, `Notification(idle_prompt)` |
| `busy` | working | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` |
| `waiting` | needs a human (e.g. permission prompt) | any other `Notification` |
| `ended` | gone | `SessionEnd`, `cardinal kill`, or tmux session missing |

`PostToolUse` also sets `busy` so a session goes back from `waiting` to `busy` after approval.
Tool events only count when already inside a turn (`busy`/`waiting`), though. Occasionally a `PreToolUse` with no matching `PostToolUse`
fires after `Stop`, with no trace in the main transcript (probably background work). Accepting it would leave a finished session stuck at `busy`.
Turns always start with `UserPromptSubmit`, so ignoring tool events while idle is safe.
If tmux is dead but no hook fired, status queries report `ended` anyway.

### Record files

`~/.cardinal/sessions/<name>/`

- `meta.json`: written once on create (name, tmux name, role, cwd, claude session ID, claude args, created time)
- `state.json`: overwritten by hooks (state, time, event, detail, last tool, transcript path)
- `events.jsonl`: every hook event appended as a line (prompts clipped to 2000 chars, tool input to 300, includes `prompt_id`)

Meta and state are split because different writers own them (Cardinal vs hooks), so they never clobber each other. Writes go to a tmp file and are renamed into place.

## Control

### send

1. Refuse if the target is `waiting` (the text would land in the dialog). `--force` overrides.
2. `tmux set-buffer` → `paste-buffer -p` (bracketed paste). Plain `send-keys` would submit at every newline.
3. Sleep 200ms, then `Enter`; sending it immediately sometimes gets swallowed by the TUI. `--no-enter` pastes only.

Sending while `busy` is fine; claude queues the message.

### keys

Straight `tmux send-keys`. For the trust dialog (`Down Enter`), permission choices, `Escape`, `C-c`, etc.

### wait

Polls the state file every 0.5s. By default returns on `idle`/`waiting`/`ended`.
`send --wait` only accepts states recorded after the send time, so it doesn't mistake the pre-send `idle` for completion.
`new --prompt --wait` waits for an `idle` whose event is `Stop` (skips the SessionStart idle).

### report

`cardinal report <name> [--tools] [--json]`. For checking what another session did.

1. **Alive?** Checks the tmux session exists.
2. **Working or done?** Phase from the hook state.

   | phase | condition |
   | --- | --- |
   | `dead` | no tmux session, or `ended` |
   | `starting` | not ready yet |
   | `working` | `busy` |
   | `waiting` | waiting for approval |
   | `done` | `idle` (turn finished, waiting for input) |

3. **Last reply**: parses the last turn from the transcript.

In the transcript, one turn is split across many lines, one per block:

```
user       text          ← instruction (turn start)
assistant  text          ← interim update
assistant  tool_use
user       tool_result
...
assistant  text          ← final answer (stop_reason: end_turn)
```

`src/transcript.ts` groups these into turns:
- Turn start = a `user` line that isn't a `tool_result` and isn't `isMeta`/`isSidechain`
- All text blocks of following `assistant` lines → `texts` (interim updates included); tool_use → `tools`
- `complete` if the last `assistant` line has `stop_reason: end_turn`

Reporting mid-turn gives the partial reply so far, marked as still in progress. Transcripts outlive the session, so dead sessions can be reported too.
`last` prints just the text from the same parse, and so does `send --wait`.

## CLI

```
cardinal new <name> [--role worker|master] [--prompt TEXT] [--wait] [-- claude args...]
cardinal ls [--json]
cardinal status <name> [--json]
cardinal send <name> <text|-> [--wait] [--timeout SEC] [--no-enter] [--force]
cardinal keys <name> <key...>
cardinal wait <name> [--timeout SEC]
cardinal screen <name> [--lines N]
cardinal report <name> [--tools] [--json]
cardinal last <name>
cardinal attach <name>
cardinal kill <name> [--purge]
cardinal serve [--host H] [--port P]
```

## Server

`cardinal serve` → default `127.0.0.1:7878`. Env: `CARDINAL_HOST`, `CARDINAL_PORT`, `CARDINAL_TOKEN`.
With a token set, every HTTP/WS request needs `?token=` or `Authorization: Bearer`.

### Terminal WebSocket `/ws/term/<name>?cols=&rows=[&readonly=1]`

Each connection spawns its own `tmux attach-session -t =cardinal-<name>` through node-pty.

- client → server (text JSON): `{"t":"i","d":"input"}`, `{"t":"r","c":cols,"r":rows}`
- server → client (binary): raw terminal output
- `readonly=1`: attaches with `-r -f ignore-size`. Input ignored, doesn't affect window size (spectator mode)
- Closing the socket kills the pty (tmux just detaches; the session keeps running). If tmux detaches, the socket closes.

### State WebSocket `/ws/events`

Sends the full list on connect, then pushes `{"type":"sessions","sessions":[...]}` whenever it changes, driven by `fs.watch` on `~/.cardinal/sessions` (150ms debounce) plus a 3s periodic check. Identical payloads are skipped.

### REST

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/sessions` | list |
| POST | `/api/sessions` | create `{name, role, prompt, args}` |
| GET | `/api/sessions/<name>` | status |
| DELETE | `/api/sessions/<name>[?purge=1]` | kill |
| POST | `/api/sessions/<name>/send` | `{text, submit, force, wait, timeoutMs}`; with wait returns `{status, last}` |
| POST | `/api/sessions/<name>/keys` | `{keys: [...]}` |
| GET | `/api/sessions/<name>/screen?lines=` | screen |
| GET | `/api/sessions/<name>/last` | last turn's reply text |
| GET | `/api/sessions/<name>/report` | `{status, phase, transcript, turn}` |

## Tested

- Worker create → file-writing task → reply via `send --wait`. Events `SessionStart → UserPromptSubmit → PreToolUse(Bash) → PostToolUse → Stop` recorded.
- Terminal WebSocket input/output/resize, state event push, 401 without token, multi-line message via REST.
- A master spawning a worker on its own → getting the answer → killing it.
- `report`: `working` + partial reply mid-turn, `done` + full reply (interim updates included) after, `dead` + history after kill. A master used `report` to fetch a worker's full reply.
- Computed transcript path matches the one reported by hooks.

## Known issues / TODO

- The first use of the workspace stops at `starting` on the trust dialog → `cardinal keys <name> Down Enter` once. It won't appear again.
- `waiting` hasn't been observed for real (test sessions ran in auto mode, so no permission prompts).
- The stray `PreToolUse` after `Stop` is now ignored, but its source is still unknown. Trace it via `promptId` in `events.jsonl`.
- A message queued while `busy` can make `send --wait` return on the previous turn's `Stop`.
- `cardinal kill` kills tmux right away, so `SessionEnd` may not fire → Cardinal writes `ended` itself.
- Web page only checked as served HTML; not tested in a browser yet.
- node-pty prebuilds ship `spawn-helper` without the exec bit, so `postinstall` chmods it.
