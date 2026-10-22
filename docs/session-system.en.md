# tmux-based Claude session system

[한국어](session-system.md)

Groundwork before Cardinal proper. One Claude Code session = one tmux session, driven from the CLI, a WebSocket server, or another Claude session.

## Overview

```
 human (terminal)      browser / external         another claude session (master)
      │                      │                              │
  cardinal CLI      cardinal-server (Python)      cardinal CLI (via Bash tool)
      └──────────┬───────────┴──────────────────────────────┘
                 ▼
          src/session.ts   ← shared create / query / control logic
            │         │
      tmux commands   ~/.cardinal/sessions/<name>/meta.json   (name ↔ instanceId)
            │         ~/.cardinal/hooks/<instanceId>/        (state.json · events.jsonl)
            ▼         ▲
   tmux session cardinal-<name>
     └─ claude (--session-id, --settings hooks) ── hooks → dist/hook.js <hook dir> ─┘
```

The CLI talks to tmux and the state files directly; no server needed. The server (`server/`, Python) calls the CLI and collects the files into a DB → [server.en.md](server.en.md).

## Files

| File | Role |
| --- | --- |
| `src/paths.ts` | Path constants. `CARDINAL_HOME` (default `~/.cardinal`), tmux prefix `cardinal-` |
| `src/tmux.ts` | Thin tmux wrapper (has/list/kill, capture-pane, send-keys, paste) |
| `src/store.ts` | Read/write session record files |
| `src/hook.ts` | Claude Code hook. Turns hook events into session state |
| `src/session.ts` | Create, status, send/keys/wait, report, kill |
| `src/transcript.ts` | Parses the transcript (jsonl) into turns |
| `src/reply.ts` | `cardinal reply` (reply to a channel event via the server) |
| `src/cli.ts` | The `cardinal` command |
| `bin/cardinal` | CLI wrapper script |

## Creating a session

`cardinal new <name>` does roughly this:

0. Working directory: by default the fixed workspace `$CARDINAL_WORKSPACE` (default `~/.cardinal/workspace`, created if missing). With `--cwd <path>`, that folder (must be an existing directory; relative paths resolve from the caller's location). Either way its realpath is recorded as `cwd` in `meta.json`. The path is validated **before** step 3 removes old records, so a bad path leaves the old records of that name intact.
1. Validate the name (`[A-Za-z0-9][A-Za-z0-9_-]{0,47}`).
   Every later step runs inside a **per-name create lock** (`sessions/.create-<name>.lock`, waits up to 30s), so creations of the same name go one at a time.
   - Inside the lock, check the current session list: a live session with that name → `이미 있는 세션: <name> (<state>)`; a tmux session of that name without Cardinal records → `이미 있는 tmux 세션`. A name with only a dead session's records is re-created.
   - The lock is released after tmux is up, so a waiting request for the same name sees the first session in the list and is rejected.
   - Without the lock, two concurrent requests both passed the check and `meta.json` could be left pointing at the instance whose tmux launch failed (session stuck at `starting` forever).
2. Mint two UUIDs: the **instanceId** (session identity, also the hook dir name) and the initial claude session ID (passed as `--session-id`).
3. Remove leftover records for that name (the name dir and the hook dir it pointed to),
   create `hooks/<instanceId>/` with `state.json (starting)`, and write `sessions/<name>/meta.json` last.
4. Launch tmux:
   ```
   tmux new-session -d -s cardinal-<name> -c <workspace> -x 200 -y 50 \
     -e CARDINAL_SESSION=<name> -e CARDINAL_INSTANCE=<instanceId> -e CARDINAL_ROLE=<role> -e CARDINAL_HOME=... -e PATH=<repo>/bin:$PATH \
     -- claude --session-id <uuid> --name <name> --settings '<hooks JSON>' \
               --append-system-prompt '<role prompt>' [claude args...] [initial prompt]
   ```
5. Set `window-size latest` so the most recently active client decides the window size.

If the tmux launch in step 4 fails, the `meta.json` and hook dir from step 3 are removed and it ends with `tmux 세션 생성 실패: <tmux error>` (no record left pointing at an instance that never started).

When claude exits, the tmux session goes away with it.

### Working directory and record locations

- **Record locations are always fixed**: `meta.json` (`$CARDINAL_HOME/sessions/<name>/`) and the hook dir (`$CARDINAL_HOME/hooks/<instanceId>/`) don't depend on the working directory, and they're all the server looks at. No Cardinal files are created in the working directory.
- **The working directory is per session**: the fixed workspace by default, changeable with `--cwd` (API: `cwd`, absolute paths only).
- claude writes transcripts to `~/.claude/projects/<working dir path with every non-alphanumeric char replaced by '-'>/<session ID>.jsonl` (under `CLAUDE_CONFIG_DIR` if set). Cardinal computes this from `meta.json`'s `cwd` (realpath) and the current session ID reported by hooks (`transcriptPath()` in `src/paths.ts`), so it works with per-session folders, symlinked paths like `/tmp`, and after the session is gone.

### Trust dialog (first use of a working directory)

claude shows a "do you trust this folder" dialog in a folder it hasn't seen. Until it's accepted the session stays `starting`.

- **Detection**: when the state is `starting`, the screen is checked for that dialog → `trustPrompt: true` + detail `작업 폴더 신뢰 다이얼로그 대기 (<path>) — cardinal keys <name> Down Enter`.
- **No waiting**: only a human (or `--trust`) can clear it, so `new --wait`/`wait` return right away (`new --wait` exits 1 with a hint) and `send` is rejected immediately. Server deliveries fail at once with the reason instead of sitting `pending` for 600s.
- **`--trust`** (API `trust: true`): if the dialog appears during creation, choose "Yes, I trust this folder" (waits up to 20s, inside the create lock). Only when explicitly given.
- Once trusted, claude remembers the folder. The default workspace also shows it once on first use.

### Hook injection

Hooks are injected via `--settings`, so the user's settings files are untouched (they merge with existing hooks). Registered events:
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`.
Command is `node <repo>/dist/hook.js <hook dir>`, 10s timeout. **The hook dir path is baked into the command as an argument.**

The hook **never writes to stdout** (SessionStart/UserPromptSubmit output gets injected into claude's context) and always exits 0, even on error.

### Session identity and hook dirs

Every session (= one claude process) has **its own hook dir**. The hook writes only there and doesn't know the session name.

```
~/.cardinal/
  sessions/<name>/meta.json         written by Cardinal only; the only place name → instanceId is linked
  hooks/<instanceId>/state.json     written only by that instance's hooks
  hooks/<instanceId>/events.jsonl
```

- **The hook dir is baked into the hook command at launch.** The hook never locates its dir by env var or name; that claude process uses that dir for its whole life.
- **Name reuse**: `new` right after `kill` with the same name gets a new instanceId → new dir. The old process's late `SessionEnd` goes to its old dir, which `new` already removed, so nothing is written. Previously this overwrote the new session's state with `ended`.
- **`/clear`**: the claude session ID changes, but it's the same process, so the same hook dir. The hook records each `session_id` it receives as `claudeSessionId` in `state.json`, and transcripts are looked up by the latest ID. `meta.json`'s `claudeSessionId` keeps the initial value (`status` shows the current one as `currentClaudeSessionId`).
- **Late hooks after purge**: neither the hook nor the store creates directories. If the dir is gone, the hook just exits. Previously a dir without meta was resurrected.
- The server DB also keys sessions by instanceId (`sessions.id`); the current claude session ID is the `claude_session_id` column.
- Sessions created the old way (no `instanceId` in meta) share the name dir. A hook called without an argument falls back to the old dir via `CARDINAL_SESSION`.

### Role prompts

- Common: "you are session `<name>` launched by Cardinal, level `<role>`", plus the absolute CLI path.
- Master only: when splitting work, spawn workers with `cardinal new ... --wait` instead of built-in subagents/workflows, unless the user asks otherwise. Includes send/ls/status/report/screen/keys/kill usage.

Why the absolute CLI path: claude's Bash tool rebuilds PATH from the user's shell profile, so tmux `-e PATH` doesn't survive. In testing, the master couldn't find `cardinal` until this was fixed.

## State

| State | Meaning | Set by |
| --- | --- | --- |
| `starting` | tmux is up, claude not ready yet (e.g. trust dialog) | Cardinal on create |
| `idle` | waiting for input | `SessionStart`, `Stop`, `Notification(idle_prompt)`, a human Esc interrupt (event `Interrupted`, below) |
| `busy` | working | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` |
| `waiting` | needs a human (e.g. permission prompt) | any other `Notification` |
| `ended` | gone | `SessionEnd`, `cardinal kill`, or tmux session missing |

`PostToolUse` also sets `busy` so a session goes back from `waiting` to `busy` after approval.
Tool events only count when already inside a turn (`busy`/`waiting`), though. Occasionally a `PreToolUse` with no matching `PostToolUse`
fires after `Stop`, with no trace in the main transcript (probably background work). Accepting it would leave a finished session stuck at `busy`.
Turns always start with `UserPromptSubmit`, so ignoring tool events while idle is safe.
If tmux is dead but no hook fired, status queries report `ended` anyway.

### Esc interrupt = human intervention

When a human presses Esc, no `Stop` hook fires and the state stays at `busy`. That turn now belongs to the human, so Cardinal steps back and **leaves it to the human**.

- Detection: look at the end of the transcript (last 512KB). If `[Request interrupted by user]` (or `… for tool use]` during a tool) comes after the last human input and is later than the hook state, the turn was interrupted.
- Handling: the state is treated as `idle` + event `Interrupted` + "사람이 중단함 (Esc)". The CLI also writes it to `state.json` when it looks (not if a hook wrote something newer meanwhile). The server's collector applies the same rule to the DB, so the web UI shows it even if nobody runs the CLI.
- Effect: a waiting `send --wait` ends right away with `interrupted: true` plus the reply up to the interrupt (measured: within 1s of Esc). The next `send` goes straight in (previously the idle wait blocked it up to 600s). `auto_reply` is not sent and the delivery records "사람이 중단함 (Esc) → 자동 답장 안 함". `report` shows phase `interrupted`.

### Record files

- `sessions/<name>/meta.json`: written once on create (name, **instanceId**, tmux name, role, cwd, initial claude session ID, claude args, created time)
- `hooks/<instanceId>/state.json`: overwritten by hooks (state, time, event, detail, last tool, transcript path, current claude session ID)
- `hooks/<instanceId>/events.jsonl`: every hook event appended as a line (prompts clipped to 2000 chars, tool input to 300, includes `prompt_id` and the claude session ID)

Meta and hook files have different writers (Cardinal vs hooks), so they live in separate directories. Writes go to a tmp file and are renamed into place.

## Control

### send

All `send`s into the same session **line up one at a time** (multiple CLIs, the server and master sessions alike). See `send` in `src/session.ts`; the lock is `src/lock.ts`.

0. **Size check**: text over 16,000 bytes is rejected right away (tmux limit, see [notes](#known-issues--todo)).
1. **Take the session lock**: `send.lock` in the hook dir. If another `send` is between paste and Enter, wait.
   - The lock file holds `<pid> <acquired ms>`. If that process is dead or has held it **over 30 minutes**, it's treated as stale and cleared (so a pid reused by another process eventually releases too).
   - Right before clearing, the content is re-read so a lock someone just took isn't removed. On release, only our own lock is removed.
   - The content is written to a tmp file first and the lock is created with `link`, so an empty lock file is never visible.
   - The old format (pid only) is still read.
2. **Wait for idle**: if the session is `busy`/`starting`, wait until idle (default max 600s, `--queue-timeout`).
   - Why: a message sent while busy doesn't queue; it **gets injected into the running turn**. Measured: 2 messages sent while busy → 3 `UserPromptSubmit`s, 1 `Stop`. Then one message ≠ one turn, and `--wait`/`auto_reply` pick up someone else's answer.
   - `--now`: don't wait, inject immediately (when you mean to).
3. Refuse if the target is `waiting` (the text would land in the dialog). `--force` overrides.
4. **Settle a just-started session**: if the state became idle via `SessionStart` less than 1.5s ago, wait until 1.5s. Right after the `SessionStart` hook the claude UI can't take input yet and Enter is swallowed (measured: with 4 sessions started at once and events sent immediately, text was left sitting in the input box).
5. Remember the transcript's turn count right before sending (= where this message's turn will be).
6. `tmux set-buffer` → `paste-buffer -p` (bracketed paste). Plain `send-keys` would submit at every newline.
7. Sleep 200ms, then `Enter`; sending it immediately sometimes gets swallowed by the TUI. `--no-enter` pastes only (and releases the lock right away).
8. **Confirm receipt + retry Enter**: watch for 3s whether the hook state changes after the send time (polled every 50ms). If not, press Enter again and wait another 3s, **up to 3 times** (a swallowed Enter leaves the text in the input box). If it was received and only the hook is late, Enter on an empty input does nothing. Still nothing → `accepted: false`.
   - With `--wait` and `accepted: false`, fail right away instead of waiting for the turn (exit 1; with `--json` the result JSON is printed first). Previously it waited until `--timeout` for the turn of a message that never went in.

Concurrent `send`s go in the order they acquire the lock.

### keys

Straight `tmux send-keys`. For the trust dialog (`Down Enter`), permission choices, `Escape`, `C-c`, etc.

### wait

Polls the state file every 0.5s. By default returns on `idle`/`waiting`/`ended`.
`send --wait` only accepts states recorded after the send time, so it doesn't mistake the pre-send `idle` for completion.
When done it prints the reply of **the turn at the position remembered in step 5** (= its own turn), not the last turn, so a `send` that starts the next turn right after can't steal it. If the transcript changed (e.g. `/clear`), it falls back to the last turn.
- **Waiting for the transcript after Stop**: the `Stop` hook arrives **before** the final reply line is written to the transcript file (measured: it shows up 80–130ms after `Stop`). Reading right away missed the final answer and `auto_reply` sent nothing. So it keeps checking for up to 5s until the turn is recorded as ending with `end_turn`. A turn stopped at `waiting` isn't waited for; what's there so far is returned.
- **Timeout**: not finishing within `--timeout` isn't a failure but "delivered, not done yet". With `--json`: `timedOut: true` plus the partial reply, exit 0. In text mode: prints the partial reply, then exit 1.
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
   | `interrupted` | `idle`, but a human interrupted with Esc (turn not finished) |

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

`src/transcript.ts` groups these into turns. Not every `user` line is human input, so lines are classified (all confirmed on real transcripts):

| `user` line | Marker | Handling |
| --- | --- | --- |
| Human input, text pasted by `send` | `origin.kind: "human"` | **turn start** |
| Background task completion `<task-notification>…` | `origin.kind: "task-notification"` | a turn claude started itself; not counted as a human turn, and its replies don't leak into the previous human turn |
| `[Request interrupted by user]` (`… for tool use]`) | no origin | ends the running human turn as `interrupted` |
| `/clear`·`/compact` command lines, command output, compaction summary | no origin | ignored (doesn't break the turn either; replies continuing after a mid-turn auto-compact stay in the same turn) |
| `tool_result`, `isMeta`, `isSidechain` | | ignored |

- Older transcripts without the `origin` field are classified by content patterns (`<command-name>`, `<local-command-`, `<task-notification>`, `This session is being continued`, …).
- After a turn start, all text blocks of `assistant` lines → `texts` (interim updates included); tool_use → `tools`
- `complete` if the last `assistant` line has `stop_reason: end_turn`
- Previously every non-human line counted as a turn start, so `last` came out empty after `/clear`/`/compact`, or the answer to a background notification showed up as the "last turn". Checked on real transcripts: a file mixing command/summary/notification lines went from 9 turns to 1 human turn. When a background notification turn occurs, `last`/`report` still show the human turn's answer and the next `send --wait` picks its own turn correctly.

Reporting mid-turn gives the partial reply so far, marked as still in progress. Transcripts outlive the session, so dead sessions can be reported too.
`last` prints just the last turn's text from the same parse. `send --wait` uses the same parser to pick its own turn.

## CLI

```
cardinal new <name> [--role worker|master] [--cwd DIR] [--trust] [--prompt TEXT] [--wait] [-- claude args...]
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
cardinal reply <event id> <text|-> [--file path]...
```

`new`/`send`/`kill` print JSON with `--json` (the server uses this).

## Server

HTTP/WebSocket, the DB and the message channel moved to a Python service → [server.en.md](server.en.md).

## Tested

- Worker create → file-writing task → reply via `send --wait`. Events `SessionStart → UserPromptSubmit → PreToolUse(Bash) → PostToolUse → Stop` recorded.
- Multi-line messages (bracketed paste).
- A master spawning a worker on its own → getting the answer → killing it.
- `report`: `working` + partial reply mid-turn, `done` + full reply (interim updates included) after, `dead` + history after kill. A master used `report` to fetch a worker's full reply.
- Computed transcript path matches the one reported by hooks.

## Known issues / TODO

- First use of a working directory stops at `starting` on the trust dialog → detected and reported right away. Create with `--trust` or run `cardinal keys <name> Down Enter` ([trust dialog](#trust-dialog-first-use-of-a-working-directory)).
- `waiting` hasn't been observed for real (test sessions ran in auto mode, so no permission prompts).
- The stray `PreToolUse` after `Stop` is now ignored, but its source is still unknown. Trace it via `promptId` in `events.jsonl`.
- `cardinal kill` only kills tmux and returns immediately; the `SessionEnd` hook (reason `other`) fires later. Cardinal also writes `ended` itself.

Confirmed by the concurrency / hook analysis (actually reproduced):

- **Concurrent hooks in the same session overwrite `state.json`.** With parallel tool calls the hook processes start in the same millisecond (3 simultaneous `PreToolUse` observed). Which of two near-simultaneous hooks wins is not determined, so a session waiting for approval can show `busy` (mechanism reproduced; not observed with a real approval prompt).
- **About 50ms of `ended` right after `/clear`**, because `SessionEnd(clear)` arrives before `SessionStart(clear)`.
- **claude starts turns by itself when a background task finishes** (`<task-notification>` input). Meanwhile the state is `busy` (correct, it's actually working). That turn's reply isn't shown by `report`/`last` (human turns only).
- Inferred (unverified): auto-compaction mid-turn would show `idle` until the turn ends because of `SessionStart(compact)`. Notification types like `auth_success` would be wrongly recorded as `waiting`.

Notes (not issues):

- **A single send is limited to 16,000 bytes.** It's the size tmux accepts in one command, so we follow it (measured limit 16,343 bytes, tmux 3.6a). Larger text is rejected before reaching tmux with `보낼 텍스트가 tmux 한 번 전달 한도를 넘음: N바이트 > 16000바이트 (tmux 제약)`. Korean is 3 bytes per character, so about 5,300 characters. Save long content to a file and send the path.

Fixed:
- Old-session hooks corrupting a re-created name, reading the old transcript after `/clear`, dirs resurrected after purge → per-session hook dirs ([Session identity and hook dirs](#session-identity-and-hook-dirs)).
- Concurrent `send`s merging into one input (always merged like `firstsecond` within 0.2s), messages sent while busy being injected into the running turn → session lock + idle wait ([send](#send)). With real claude, two events 0.1s apart now become two separate turns and each auto reply is correct.
- Stuck at `busy` after an Esc interrupt, blocking `wait`/`send` → handled as human intervention ([Esc interrupt](#esc-interrupt--human-intervention)).
- The transcript parser treated command lines, compaction summaries and background notifications as turns → human input only ([report](#report)).
