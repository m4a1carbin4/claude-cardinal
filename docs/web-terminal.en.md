# How the web terminal works

[한국어](web-terminal.md) · Related: [session system](session-system.en.md)

The question: the server only relays bytes over a WebSocket, so how does `index.html` turn that into a live tmux screen?

Short answer: **the server never builds a screen.** It hands tmux a pseudo-terminal (pty) so tmux believes it's attached to a real terminal, then forwards the raw bytes coming out of it (text + ANSI control codes) straight to the browser. Interpreting those bytes and drawing the screen is done in the browser by **xterm.js**, a terminal emulator written in JS. It does the same job iTerm or Terminal.app would do, just inside a web page.

## Big picture

```
 browser (index.html)                     cardinal serve (node)                   tmux
┌───────────────────────┐   WebSocket   ┌────────────────────────┐   pty    ┌──────────────────────────┐
│ xterm.js              │◀── binary ────│ node-pty               │◀────────│ tmux client              │
│  · parse bytes        │   (output)    │  └ tmux attach-session │         │ (attach-session process) │
│  · draw screen        │               │                        │         │        ▲ unix socket     │
│  · keys → bytes       │── JSON ──────▶│ term.write / resize    │────────▶│ tmux server              │
└───────────────────────┘ (input/resize)└────────────────────────┘         │  └ pane (pty) ─ claude    │
                                                                            └──────────────────────────┘
```

The key is that there are two ptys:

1. **pane pty**: created by the tmux server when it launched claude. claude draws into it. It exists regardless of any browser.
2. **attach pty**: created by the server with node-pty for every WebSocket connection. `tmux attach-session` runs inside it.

So the browser isn't seeing claude's output directly. It's seeing **what a tmux client draws**. It's exactly like running `tmux attach` in a terminal app, with "node-pty + WebSocket + xterm.js" standing in for the terminal app.

## The pieces

### pty (pseudo-terminal)

A pair of kernel-provided file handles (master / slave).

- The program given the slave side (here, the tmux client) thinks it's on a real terminal, so it draws colors, cursor movement and full-screen UI normally.
- The program holding the master side (node-pty) reads that output and writes keystrokes in.
- The pty also holds the window size (cols/rows). Changing it sends `SIGWINCH` to the program on the slave side.

A plain `spawn` with pipes won't work: tmux sees "not a terminal" and refuses to attach. That's why node-pty is needed.

### tmux client / server

tmux is client-server by design.

- **tmux server**: owns sessions, windows and panes; claude runs here. Keeps running with nobody attached.
- **tmux client**: the process you get from `tmux attach`. It connects to the server over a unix socket and renders the server's screen state **onto its own terminal**.

The client sees `TERM=xterm-256color` and draws using xterm-style control codes. xterm.js is an emulator that understands exactly those codes, so the two fit together.

### xterm.js

A browser terminal emulator library, loaded by `index.html` from a CDN (`public/index.html:58-59`).

- Parses ANSI/VT control codes from incoming bytes, keeps an internal character grid (rows × cols, with color/attributes per cell) and renders it.
- Turns keyboard input into the bytes a terminal would send (`↑` → `ESC [ A`, `Enter` → `\r`, `Ctrl+C` → `0x03`).
- Automatically answers queries tmux sends (terminal type, colors, …). Those answers go out on the input channel too.

**FitAddon** computes cols/rows from the container's pixel size ÷ one character cell, and sizes the terminal to fit.

## The actual bytes

First bytes received when attaching node-pty to a tiny tmux session (40×5, printing `hello world`):

```
\e[?1049h               switch to alternate (full-screen) buffer
\e[H\e[2J               cursor home, clear screen
\e[?2004h               enable bracketed paste
\e[c  \e[>c  \e[>q      "what terminal are you?" queries
\e]10;?\e\\ \e]11;?\e\\  "what are your fg/bg colors?" queries
\e[32m\e[1m\e[Hhello    green + bold, "hello" at (1,1)
\e(B\e[m world\e[K      reset attributes, " world", clear to end of line
\e[30m\e[42m ... [demo-raw] ... 22:36 24-Sep-26
                        status line at the bottom, black on green
```

That's all it is: text like "hello" interleaved with `\e[...` control codes. The server doesn't interpret a single byte; it puts them in WebSocket binary frames. xterm.js parses them and you get a green "hello" and a status line.

The queries in the middle (`\e[c` etc.) are answered by xterm.js immediately via `onData`. So the input channel carries not only keystrokes but also these replies back to tmux.

## Following the flow

### 1. Opening the page

1. `GET /` → the server returns `public/index.html` as-is (`serve` in `src/server.ts`).
2. The browser fetches xterm.js and FitAddon from the CDN.
3. It connects to the `/ws/events` WebSocket for the session list (`public/index.html:87-88`). That's a separate status channel, unrelated to the terminal.

### 2. Clicking a session → attaching

Browser (`public/index.html:99-111`):

```js
term = new Terminal({...});
fit = new FitAddon.FitAddon(); term.loadAddon(fit);
term.open($('term'));          // mount the terminal in the DOM
fit.fit();                     // compute size → term.cols / term.rows
const ws = new WebSocket('/ws/term/<name>?cols=..&rows=..');
ws.binaryType = 'arraybuffer';
```

cols/rows go in the query string so the pty is created at the right size and tmux draws the first screen at that size.

Server (`src/server.ts:99-110`, upgrade handling at `:194`):

```ts
const term = pty.spawn('tmux', ['attach-session', '-t', '=cardinal-<name>'], {
  name: 'xterm-256color', cols, rows, ...
});
term.onData((d) => ws.send(Buffer.from(d, 'utf8')));
```

`tmux attach` **redraws the whole current screen** as soon as it attaches. So the browser sees the current screen immediately, with no separate snapshot (`capture-pane`) needed.

### 3. Output: claude → browser

```
claude writes to the pane pty
 → tmux server updates the pane's screen state
 → tmux client redraws only what changed, as control codes (into the attach pty)
 → node-pty onData
 → ws.send(binary)
 → browser ws.onmessage → term.write(new Uint8Array(e.data))
 → xterm.js parses and updates the screen
```

The tmux client redraws only changed cells, not the whole screen, so a spinner in claude produces only a trickle of bytes.

### 4. Input: keyboard → claude

```
key pressed in the browser
 → xterm.js onData(d)  (d = terminal-style bytes, e.g. "\x1b[A")
 → ws.send(JSON {t:'i', d})
 → server term.write(d)  (into the attach pty master)
 → tmux client stdin
 → tmux server routes it to the pane
 → claude stdin
```

tmux key bindings (`Ctrl+B` etc.) flow the same way, so tmux itself is usable from the web.

### 5. Resize

```
browser window resized
 → ResizeObserver → fit.fit() → new cols/rows
 → term.onResize → ws.send({t:'r', c, r})
 → server term.resize(c, r)  (changes the pty window size)
 → tmux client gets SIGWINCH and tells the server its new size
 → with window-size latest, the window follows the most recently active client
 → pane pty is resized too → claude gets SIGWINCH and redraws
```

### 6. Disconnecting

- Closing the tab / clicking another session → WebSocket closes → server `term.kill()` (`src/server.ts:123`) → tmux client exits = **detach**. The tmux server and claude keep running.
- If tmux goes away first (session killed, etc.) → `onExit` → WebSocket closes (`:110`) → the browser shows "disconnected".

## Common questions

**Why is input JSON but output binary?**
Output is high-volume and needs no interpretation, so it's sent raw. Input has two kinds of messages (keystrokes and resize), so JSON distinguishes them.

**What if a multi-byte character (e.g. Korean) gets split?**
In utf8 mode node-pty uses a streaming decoder, so it never hands over a string cut mid-character. The server re-encodes to utf8 bytes and xterm.js decodes them.

**What happens with several browsers attached at once?**
Each connection gets its own tmux client. They all show the same session, and anyone's typing goes to the same claude. With `window-size latest`, the window size follows whoever typed or resized last.

**What about spectator mode (`readonly=1`)?**
It attaches with `tmux attach -r -f ignore-size`. tmux ignores that client's input and leaves its size out of the window-size calculation. The server also drops its input messages.

**Why is there no scrollback?**
The browser only gets the "current screen" the tmux client draws. Past output lives in the tmux server's pane history. You can scroll it with tmux copy mode (`Ctrl+B [`) from the web, or pull it as text with `GET /api/sessions/<name>/screen?lines=N`.

**Why not just use ttyd?**
ttyd works on the same principle (pty + WebSocket + xterm.js). Building it ourselves puts the session list, status events, auth and spectator mode in the one Cardinal server.
