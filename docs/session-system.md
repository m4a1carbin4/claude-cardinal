# tmux 기반 Claude 세션 시스템

[English](session-system.en.md)

카디널 본체 들어가기 전 바닥 공사. Claude Code 세션 하나 = tmux 세션 하나, 그걸 CLI/웹소켓/다른 claude 세션에서 만지는 구조.

## 한눈에

```
 사람 (터미널)        브라우저 / 외부          다른 claude 세션 (마스터)
      │                    │                         │
  cardinal CLI      cardinal serve (HTTP/WS)    cardinal CLI (Bash 도구)
      └──────────┬─────────┴─────────────────────────┘
                 ▼
          src/session.ts   ← 생성/조회/제어 공통 로직
            │         │
      tmux 명령     ~/.cardinal/sessions/<이름>/
            │         ▲   meta.json · state.json · events.jsonl
            ▼         │
   tmux 세션 cardinal-<이름>
     └─ claude (--session-id, --settings 훅) ── 훅 → dist/hook.js ─┘
```

CLI는 서버 없이 tmux랑 파일만 직접 만짐. 서버는 같은 로직을 HTTP/WS로 노출하는 것뿐.

## 파일 구성

| 파일 | 역할 |
| --- | --- |
| `src/paths.ts` | 경로 상수. `CARDINAL_HOME` (기본 `~/.cardinal`), tmux 접두사 `cardinal-` |
| `src/tmux.ts` | tmux 명령 얇은 래퍼 (has/list/kill, capture-pane, send-keys, paste) |
| `src/store.ts` | 세션 기록 파일 읽기/쓰기 |
| `src/hook.ts` | Claude Code 훅. 이벤트 받아서 상태 갱신 |
| `src/session.ts` | 생성, 상태 조회, send/keys/wait, report, kill |
| `src/transcript.ts` | 트랜스크립트(jsonl)를 턴 단위로 파싱 |
| `src/server.ts` | HTTP REST + 웹소켓 (터미널, 상태 이벤트) |
| `src/cli.ts` | `cardinal` 명령 |
| `public/index.html` | 웹 터미널 (xterm.js) |
| `bin/cardinal` | CLI 래퍼 스크립트 |

## 세션 만들기

`cardinal new <이름>` 하면 대충 이렇게 돌아감:

0. 작업 폴더는 항상 고정: `$CARDINAL_WORKSPACE` (기본 `~/.cardinal/workspace`). 없으면 만들고 실제 경로(realpath)로 씀.
1. 이름 검사 (`[A-Za-z0-9][A-Za-z0-9_-]{0,47}`), 같은 이름 tmux 세션 있으면 에러.
2. UUID 하나 만들어서 claude 세션 ID로 씀 → 카디널이 처음부터 ID를 앎.
3. 예전에 같은 이름으로 남은 기록 폴더 지우고 `meta.json`, `state.json(starting)` 새로 씀.
4. tmux 실행:
   ```
   tmux new-session -d -s cardinal-<이름> -c <작업 폴더> -x 200 -y 50 \
     -e CARDINAL_SESSION=<이름> -e CARDINAL_ROLE=<role> -e CARDINAL_HOME=... -e PATH=<repo>/bin:$PATH \
     -- claude --session-id <uuid> --name <이름> --settings '<훅 JSON>' \
               --append-system-prompt '<역할 프롬프트>' [claude 인자...] [첫 프롬프트]
   ```
5. `window-size latest` 설정 → 여러 군데서 붙어도 마지막에 만진 쪽 크기 따라감.

claude가 종료되면 tmux 세션도 같이 사라짐.

### 왜 작업 폴더를 고정하나

claude는 트랜스크립트를 `~/.claude/projects/<작업 폴더 경로에서 영숫자 아닌 건 전부 '-'>/<세션 ID>.jsonl` 에 씀
(`CLAUDE_CONFIG_DIR` 쓰면 그 아래). 작업 폴더가 하나로 고정돼 있고 세션 ID는 카디널이 정해서 넘기니까,
트랜스크립트 경로를 훅 없이도 바로 계산할 수 있음 (`transcriptPath()` in `src/paths.ts`). 세션이 죽은 뒤에도 마찬가지.
덤으로 신뢰 다이얼로그도 이 폴더에서 한 번만 받으면 끝.

### 훅 주입

`--settings`로 훅을 넣어서 사용자 설정 파일은 안 건드림 (기존 훅이랑 합쳐짐). 등록하는 이벤트:
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`.
명령은 `node <repo>/dist/hook.js`, 타임아웃 10초.

훅은 `CARDINAL_SESSION` 환경변수 없으면 아무것도 안 함. 그리고 **stdout에 절대 아무것도 안 찍음** (SessionStart/UserPromptSubmit 출력은 claude 컨텍스트에 들어가버려서). 에러 나도 항상 exit 0.

### 역할 프롬프트

- 공통: "너는 카디널이 띄운 세션 `<이름>`, 레벨은 `<role>`", CLI 절대경로 알려줌.
- 마스터만: 작업 나눌 때 내장 서브 에이전트/워크플로 말고 `cardinal new ... --wait`로 워커 띄우라고 함. 사용자가 따로 요청하면 예외. send/ls/status/report/screen/keys/kill 사용법 포함.

CLI를 절대경로로 박는 이유: claude의 Bash 도구가 사용자 셸 프로필로 PATH를 다시 잡아서 tmux `-e PATH`가 안 먹음. 테스트 때 마스터가 `cardinal`을 못 찾았음.

## 상태

| 상태 | 뜻 | 찍는 이벤트 |
| --- | --- | --- |
| `starting` | tmux는 떴는데 claude 준비 전 (신뢰 다이얼로그 등) | 생성 시 카디널이 씀 |
| `idle` | 입력 대기 | `SessionStart`, `Stop`, `Notification(idle_prompt)` |
| `busy` | 작업 중 | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` |
| `waiting` | 승인 같은 사람 손 필요 | 그 밖의 `Notification` |
| `ended` | 종료 | `SessionEnd`, `cardinal kill`, 또는 tmux 세션이 없으면 |

`PostToolUse`도 `busy`로 찍는 건 승인 후 `waiting`에서 다시 `busy`로 돌아오게 하려고.
단, 도구 이벤트는 이미 턴 안(`busy`/`waiting`)일 때만 반영함. `Stop` 뒤에 `PostToolUse` 없는 `PreToolUse`가 가끔 찍히는데
메인 트랜스크립트엔 흔적이 없음 (백그라운드 작업으로 추정). 이걸 받아주면 끝난 세션이 계속 `busy`로 보여서 막아둠.
턴은 항상 `UserPromptSubmit`으로 시작하니까 문제없음.
tmux가 죽었는데 훅이 못 찍은 경우도 조회할 때 `ended`로 보정.

### 기록 파일

`~/.cardinal/sessions/<이름>/`

- `meta.json`: 만들 때 한 번 씀 (이름, tmux 이름, role, cwd, claude 세션 ID, claude 인자, 생성 시각)
- `state.json`: 훅이 계속 덮어씀 (state, 시각, 이벤트, detail, 마지막 도구, transcript 경로)
- `events.jsonl`: 훅 이벤트 전부 한 줄씩 추가 (프롬프트는 2000자, 도구 입력은 300자까지만, `prompt_id` 포함)

meta랑 state를 나눈 건 쓰는 쪽이 달라서 (카디널 vs 훅) 서로 덮어쓰지 않게. 쓸 때는 tmp 파일에 쓰고 rename.

## 제어

### send

1. 대상이 `waiting`이면 거부 (다이얼로그에 텍스트가 들어가니까). `--force`로 무시 가능.
2. `tmux set-buffer` → `paste-buffer -p` (bracketed paste). `send-keys`로 보내면 줄바꿈에서 엔터로 먹혀서 이렇게 함.
3. 200ms 쉬고 `Enter`. 바로 치면 TUI가 가끔 삼킴. `--no-enter`면 붙여넣기만.

`busy`일 때 보내면 claude 쪽에서 큐에 쌓아둠.

### keys

`tmux send-keys` 그대로. 신뢰 다이얼로그 (`Down Enter`), 승인 선택지, `Escape`, `C-c` 같은 거.

### wait

0.5초마다 상태 파일 확인. 기본은 `idle`/`waiting`/`ended` 중 하나 되면 끝.
`send --wait`는 보낸 시각 이후에 찍힌 상태만 인정해서, 보내자마자 아직 `idle`인 걸 끝난 걸로 착각하지 않음.
`new --prompt --wait`는 이벤트가 `Stop`인 `idle`까지 기다림 (SessionStart의 idle은 건너뜀).

### report (결과 보고)

`cardinal report <이름> [--tools] [--json]`. 다른 세션이 뭘 했는지 확인하는 용도.

1. **살아있나**: tmux 세션 있는지 확인.
2. **작업 중인가, 끝났나**: 훅 상태로 phase 결정.

   | phase | 조건 |
   | --- | --- |
   | `dead` | tmux 없음, 또는 `ended` |
   | `starting` | 아직 준비 전 |
   | `working` | `busy` |
   | `waiting` | 승인 대기 |
   | `done` | `idle` (턴 끝나고 입력 대기) |

3. **마지막 응답**: 트랜스크립트에서 마지막 턴을 파싱해서 가져옴.

트랜스크립트는 한 턴이 블록 단위로 여러 줄에 쪼개져 있음:

```
user       text          ← 지시 (턴 시작)
assistant  text          ← 중간 보고
assistant  tool_use
user       tool_result
...
assistant  text          ← 마지막 답 (stop_reason: end_turn)
```

`src/transcript.ts`가 이걸 턴으로 묶음:
- 턴 시작 = `user` 줄 중에 `tool_result`가 아니고 `isMeta`/`isSidechain`도 아닌 것
- 그 뒤 `assistant` 줄의 text 블록 전부 → `texts` (중간 보고 포함), tool_use → `tools`
- 마지막 `assistant` 줄의 `stop_reason`이 `end_turn`이면 `complete`

작업 중일 때 report 하면 지금까지 쓴 부분 응답이 나오고 "아직 진행 중" 표시가 붙음. 세션이 죽은 뒤에도 트랜스크립트는 남아 있어서 report 됨.
`last`는 같은 파싱 결과에서 텍스트만 출력하고, `send --wait`도 이걸 출력함.

## CLI

```
cardinal new <이름> [--role worker|master] [--prompt TEXT] [--wait] [-- claude 인자...]
cardinal ls [--json]
cardinal status <이름> [--json]
cardinal send <이름> <텍스트|-> [--wait] [--timeout 초] [--no-enter] [--force]
cardinal keys <이름> <키...>
cardinal wait <이름> [--timeout 초]
cardinal screen <이름> [--lines N]
cardinal report <이름> [--tools] [--json]
cardinal last <이름>
cardinal attach <이름>
cardinal kill <이름> [--purge]
cardinal serve [--host H] [--port P]
```

## 서버

`cardinal serve` → 기본 `127.0.0.1:7878`. 환경변수 `CARDINAL_HOST`, `CARDINAL_PORT`, `CARDINAL_TOKEN`.
토큰 있으면 HTTP/WS 전부 `?token=` 또는 `Authorization: Bearer` 필요.

### 터미널 웹소켓 `/ws/term/<이름>?cols=&rows=[&readonly=1]`

접속마다 node-pty로 `tmux attach-session -t =cardinal-<이름>` 하나 띄워서 연결.

- 클라 → 서버 (텍스트 JSON): `{"t":"i","d":"입력"}`, `{"t":"r","c":cols,"r":rows}`
- 서버 → 클라 (바이너리): 터미널 출력 그대로
- `readonly=1`: `attach -r -f ignore-size`로 붙음. 입력 무시, 창 크기에도 영향 없음 (관전용)
- 웹소켓 닫히면 pty 종료 (tmux에서 detach만 되고 세션은 그대로). tmux가 끊기면 웹소켓도 닫힘.

### 상태 웹소켓 `/ws/events`

접속하면 전체 목록 한 번, 이후 `~/.cardinal/sessions` 변경 감지(`fs.watch`, 150ms 디바운스) + 3초 주기 확인으로 바뀔 때마다 `{"type":"sessions","sessions":[...]}` 푸시. 내용 같으면 안 보냄.

### REST

| 메서드 | 경로 | 내용 |
| --- | --- | --- |
| GET | `/api/sessions` | 목록 |
| POST | `/api/sessions` | 생성 `{name, role, prompt, args}` |
| GET | `/api/sessions/<이름>` | 상태 |
| DELETE | `/api/sessions/<이름>[?purge=1]` | 종료 |
| POST | `/api/sessions/<이름>/send` | `{text, submit, force, wait, timeoutMs}`. wait면 `{status, last}` 반환 |
| POST | `/api/sessions/<이름>/keys` | `{keys: [...]}` |
| GET | `/api/sessions/<이름>/screen?lines=` | 화면 |
| GET | `/api/sessions/<이름>/last` | 마지막 턴 응답 텍스트 |
| GET | `/api/sessions/<이름>/report` | `{status, phase, transcript, turn}` |

## 테스트해본 것

- 워커 생성 → 파일 쓰기 지시 → `send --wait`로 응답 받기. 이벤트 `SessionStart → UserPromptSubmit → PreToolUse(Bash) → PostToolUse → Stop` 확인.
- 웹소켓 터미널 입력/출력/리사이즈, 상태 이벤트 푸시, 토큰 없으면 401, REST로 여러 줄 메시지.
- 마스터가 알아서 워커 띄우고 → 답 받고 → kill.
- `report`: 작업 중엔 `working` + 부분 응답, 끝나면 `done` + 중간 보고까지 포함한 전체 응답, kill 뒤엔 `dead` + 기록. 마스터가 `report`로 워커 응답 전체를 받아옴.
- 계산한 트랜스크립트 경로 = 훅이 알려준 경로 (일치 확인).

## 알려진 문제 / 할 것

- 작업 폴더를 처음 쓸 때 신뢰 다이얼로그 때문에 `starting`에서 멈춤 → `cardinal keys <이름> Down Enter` 한 번. 이후엔 안 뜸.
- `waiting` 상태는 실제로 못 띄워봄 (테스트 세션이 auto mode라 승인 프롬프트가 안 뜸).
- `Stop` 뒤 정체불명 `PreToolUse`는 막아뒀지만 정체는 아직 모름. `events.jsonl`의 `promptId`로 추적 가능.
- `busy`일 때 보내서 큐에 쌓인 메시지는 `send --wait`가 앞 턴의 `Stop`에서 끝나버릴 수 있음.
- `cardinal kill`은 tmux를 바로 죽여서 `SessionEnd` 훅이 안 뜰 수 있음 → 카디널이 직접 `ended` 씀.
- 웹 페이지는 서버가 HTML 내려주는 것까지만 확인, 브라우저 테스트는 아직.
- node-pty 프리빌드에 `spawn-helper` 실행 권한이 빠져 있어서 `postinstall`에서 chmod.
