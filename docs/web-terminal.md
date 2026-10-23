# 웹 터미널은 어떻게 도는가

[English](web-terminal.en.md) · 관련: [세션 시스템](session-system.md), [서버](server.md)

> 처음엔 Node 서버(node-pty)였고 지금은 Python 서버(`ptyprocess`)로 옮김. 원리는 완전히 같음.

궁금했던 거: 서버는 웹소켓으로 바이트만 넘겨주는데, 웹 페이지는 그걸로 어떻게 tmux 화면을 띄우는 거지?

> 웹 UI는 처음엔 단일 `index.html`이었고 지금은 `web/` (Vite + React + TypeScript)로 바뀜. 터미널 부분은 `web/src/components/TerminalView.tsx`. 원리는 같음.

한 줄 답: **서버는 화면을 만들지 않음.** tmux가 "진짜 터미널에 붙었다"고 믿게 가짜 터미널(pty)을 하나 쥐여주고, 거기서 나오는 raw 바이트(글자 + ANSI 제어 코드)를 그대로 브라우저로 흘려보냄. 그 바이트를 해석해서 화면으로 그리는 건 브라우저 안의 **xterm.js** (JS로 만든 터미널 에뮬레이터)가 함. iTerm이나 macOS 터미널 앱이 하는 일을 브라우저 안에서 대신 하는 것.

## 전체 그림

```
 브라우저 (web UI)                        cardinal-server (python)                tmux
┌───────────────────────┐   WebSocket   ┌────────────────────────┐   pty    ┌──────────────────────────┐
│ xterm.js              │◀── 바이너리 ──│ ptyprocess             │◀────────│ tmux 클라이언트           │
│  · 바이트 해석         │    (출력)     │  └ tmux attach-session │         │ (attach-session 프로세스) │
│  · 화면 그리기         │               │                        │         │        ▲ 유닉스 소켓      │
│  · 키 입력 → 바이트    │── JSON ──────▶│ os.write / setwinsize  │────────▶│ tmux 서버                │
└───────────────────────┘ (입력/리사이즈)└────────────────────────┘         │  └ pane (pty) ─ claude    │
                                                                            └──────────────────────────┘
```

pty가 두 군데 있다는 게 핵심:

1. **pane pty**: tmux 서버가 claude를 띄울 때 만든 것. claude는 여기에 화면을 그림. 원래부터 있음.
2. **attach pty**: 웹소켓 접속할 때마다 서버가 `ptyprocess`로 새로 만드는 것. 이 안에서 `tmux attach-session`이 돌아감.

그러니까 브라우저가 보는 건 claude의 출력이 아니라 **tmux 클라이언트가 그려주는 화면**임. 사람이 터미널 앱에서 `tmux attach` 하는 것과 완전히 똑같고, 터미널 앱 자리에 "pty + 웹소켓 + xterm.js"가 들어간 것뿐.

## 등장인물

### pty (가짜 터미널)

커널이 주는 파일 한 쌍 (master / slave).

- slave 쪽을 받은 프로그램(여기선 tmux 클라이언트)은 자기가 진짜 터미널에 붙어 있다고 생각함. 그래서 색깔, 커서 이동, 전체 화면 UI를 정상적으로 그림.
- master 쪽을 쥔 프로그램(서버, `ptyprocess`)은 그 출력을 읽고, 키 입력을 써넣을 수 있음.
- 창 크기(cols/rows)도 pty가 들고 있음. 바꾸면 slave 쪽 프로그램이 `SIGWINCH` 신호를 받음.

그냥 `spawn`으로 파이프만 연결하면 tmux는 "터미널이 아니네" 하고 안 붙음. 그래서 pty를 만들어주는 라이브러리(`ptyprocess`)가 필요함.

### tmux 클라이언트 / 서버

tmux는 원래 서버-클라이언트 구조.

- **tmux 서버**: 세션, 창, pane을 들고 있고 claude가 돌아가는 곳. 아무도 안 붙어 있어도 계속 돌아감.
- **tmux 클라이언트**: `tmux attach` 하면 뜨는 프로세스. 유닉스 소켓으로 서버에 붙어서, 서버가 가진 화면 상태를 **자기 터미널에** 그려줌.

클라이언트는 `TERM=xterm-256color`를 보고 "xterm 계열 터미널이구나" 하고 거기에 맞는 제어 코드로 그림. xterm.js가 바로 그 xterm 제어 코드를 알아먹는 에뮬레이터라서 짝이 맞음.

### xterm.js

브라우저용 터미널 에뮬레이터 라이브러리. 웹 UI가 npm 패키지(`@xterm/xterm`, `@xterm/addon-fit`)로 번들에 넣음. 터미널 탭을 열 때만 불러옴 (`web/src/components/SessionView.tsx`의 `lazy`).

- 들어온 바이트에서 ANSI/VT 제어 코드를 해석해서 내부에 글자 격자(행×열, 글자마다 색/속성)를 유지하고 화면에 그림.
- 키보드 입력을 "터미널이라면 보냈을 바이트"로 바꿔줌 (`↑` → `ESC [ A`, `Enter` → `\r`, `Ctrl+C` → `0x03`).
- tmux가 던지는 질문(터미널 종류, 색 등)에도 알아서 대답함. 대답도 입력 채널로 나감.

**FitAddon**은 컨테이너 픽셀 크기 ÷ 글자 한 칸 크기로 cols/rows를 계산해서 터미널 크기를 맞춰주는 애드온.

## 실제로 흐르는 바이트

작은 tmux 세션(40×5, `hello world` 출력)에 pty로 attach 했을 때 처음 받은 바이트 일부 (Node 시절 node-pty로 실험, 바이트는 tmux가 만드는 거라 똑같음):

```
\e[?1049h               대체 화면(전체화면 모드) 켜기
\e[H\e[2J               커서 맨 위로, 화면 지우기
\e[?2004h               bracketed paste 켜기
\e[c  \e[>c  \e[>q      "너 무슨 터미널이야?" 질문들
\e]10;?\e\\ \e]11;?\e\\  "글자색/배경색 뭐야?" 질문
\e[32m\e[1m\e[Hhello    초록 + 굵게, (1,1)에 "hello"
\e(B\e[m world\e[K      속성 리셋, " world", 줄 끝까지 지우기
\e[30m\e[42m ... [demo-raw] ... 22:36 24-Sep-26
                        검정 글자/초록 배경으로 맨 아래 상태줄
```

이게 전부임. "hello" 같은 글자와 `\e[...` 제어 코드가 섞인 바이트열. 서버는 이걸 한 글자도 해석 안 하고 웹소켓 바이너리 프레임에 담아서 보냄. xterm.js가 받아서 해석하면 초록색 "hello"와 상태줄이 그려짐.

중간의 질문들(`\e[c` 등)은 xterm.js가 받자마자 대답을 만들어서 `onData`로 내보냄. 그래서 입력 채널에는 키 입력만 있는 게 아니라 이런 대답도 섞여서 tmux로 돌아감.

## 흐름 따라가기

### 1. 페이지 열기

1. `GET /` → 서버가 웹 UI 빌드 결과 `web/dist/index.html`을 내려줌 (`server/cardinal_server/app.py`의 `index`). JS/CSS는 `/assets/…`.
2. 브라우저가 CDN에서 xterm.js, FitAddon을 받음.
3. `/ws/events` 웹소켓에 붙어서 세션 목록을 받음 (`web/src/App.tsx`, 재연결은 `web/src/hooks.ts`의 `useJsonSocket`). 터미널이랑은 별개인 상태 알림 채널.

### 2. 세션 클릭 → 붙기

브라우저 (`web/src/components/TerminalView.tsx:19-38`):

```ts
const term = new Terminal({ ... });
const fit = new FitAddon(); term.loadAddon(fit);
term.open(el);                 // DOM에 터미널 붙이기
fit.fit();                     // 크기 계산 → term.cols / term.rows
const ws = new WebSocket(wsUrl(`/ws/term/${name}`, { cols: term.cols, rows: term.rows }));
ws.binaryType = 'arraybuffer';
```

cols/rows를 쿼리로 같이 보내는 이유: 처음부터 맞는 크기로 pty를 만들어야 tmux가 첫 화면을 제대로 된 크기로 그림.

서버 (`server/cardinal_server/terminal.py:18-42`, 웹소켓 라우트는 `app.py`의 `ws_term`):

```python
args = ["tmux", "attach-session", "-t", f"={tmux_name}"]
proc = PtyProcess.spawn(args, dimensions=(rows, cols), env={**os.environ, "TERM": "xterm-256color"})
loop.add_reader(proc.fd, on_readable)       # pty에서 읽을 게 생기면
...
data = os.read(proc.fd, 65536)              # 읽은 바이트를
await ws.send_bytes(data)                   # 그대로 웹소켓으로
```

`tmux attach`는 붙자마자 **현재 화면 전체를 다시 그림**. 그래서 브라우저는 따로 화면 스냅샷(`capture-pane`)을 안 받아도 접속 즉시 지금 화면이 보임.

### 3. 출력: claude → 브라우저

```
claude가 pane pty에 출력
 → tmux 서버가 pane 화면 상태 갱신
 → tmux 클라이언트가 바뀐 부분만 제어 코드로 다시 그림 (attach pty에 씀)
 → 서버 os.read(pty fd)
 → ws.send(바이너리)
 → 브라우저 ws.onmessage → term.write(new Uint8Array(e.data))
 → xterm.js가 해석해서 화면 갱신
```

tmux 클라이언트는 화면 전체가 아니라 바뀐 칸만 다시 그림. 그래서 claude가 스피너만 돌려도 바이트는 조금씩만 흐름.

### 4. 입력: 키보드 → claude

```
브라우저에서 키 누름
 → xterm.js onData(d)  (d = 터미널식 바이트, 예: "\x1b[A")
 → ws.send(JSON {t:'i', d})
 → 서버 os.write(pty fd, d)  (attach pty master에 씀)
 → tmux 클라이언트 stdin
 → tmux 서버가 해당 pane으로 전달
 → claude stdin
```

tmux 단축키(`Ctrl+B` 등)도 똑같이 흘러가니까 웹에서도 tmux 조작이 됨.

### 5. 리사이즈

```
브라우저 창 크기 바뀜
 → ResizeObserver → fit.fit() → 새 cols/rows 계산
 → term.onResize → ws.send({t:'r', c, r})
 → 서버 proc.setwinsize(r, c)  (pty 창 크기 변경)
 → tmux 클라이언트가 SIGWINCH 받고 서버에 새 크기 알림
 → window-size latest 라서 마지막에 만진 클라이언트 크기로 창 크기 변경
 → pane pty도 크기 바뀜 → claude가 SIGWINCH 받고 다시 그림
```

### 6. 끊기

- 브라우저 탭 닫음 / 다른 세션 클릭 → 웹소켓 닫힘 → 서버 `proc.terminate()` (`terminal.py:69`) → tmux 클라이언트 종료 = **detach**. tmux 서버랑 claude는 그대로 돌아감.
- 반대로 tmux 쪽이 끊기면 (세션 kill 등) → pty 읽기가 EOF → 웹소켓 닫힘 (`terminal.py:42`) → 브라우저에 "연결 끊김" 표시.

## 자주 헷갈리는 것

**왜 입력은 JSON이고 출력은 바이너리?**
출력은 양이 많고 해석할 필요가 없어서 그대로 바이너리. 입력은 "키 입력"이랑 "리사이즈" 두 종류라 구분하려고 JSON.

**한글 같은 멀티바이트가 중간에 잘리면?**
서버는 pty에서 읽은 바이트를 디코딩 안 하고 그대로 보냄. 글자가 청크 경계에서 잘려도 xterm.js의 UTF-8 디코더가 다음 청크랑 이어서 해석함.

**여러 브라우저에서 동시에 붙으면?**
접속마다 tmux 클라이언트가 하나씩 따로 생김. 전부 같은 세션을 보고, 누가 쳐도 같은 claude에 들어감. 창 크기는 `window-size latest` 때문에 마지막에 입력/리사이즈한 쪽 기준.

**관전 모드(`readonly=1`)는?**
`tmux attach -r -f ignore-size`로 붙음. tmux가 이 클라이언트 입력을 무시하고, 이 클라이언트 크기는 창 크기 계산에서 빠짐. 서버도 입력 메시지를 버림.

**스크롤백이 안 보이는 이유?**
브라우저가 받는 건 tmux 클라이언트가 그리는 "현재 화면"뿐. 과거 출력은 tmux 서버의 pane 히스토리에 있음. 웹에서도 tmux copy mode(`Ctrl+B [`)로 올려볼 수 있고, `GET /api/sessions/<이름>/screen?lines=N`으로 텍스트로 뽑을 수도 있음.

**왜 ttyd 안 쓰고 직접?**
ttyd도 원리는 똑같음 (pty + 웹소켓 + xterm.js). 직접 만들면 세션 목록, 상태 이벤트, 인증, 관전 모드를 카디널 서버 하나에 묶을 수 있어서.
