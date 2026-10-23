# tmux 기반 Claude 세션 시스템

[English](session-system.en.md)

카디널 본체 들어가기 전 바닥 공사. Claude Code 세션 하나 = tmux 세션 하나, 그걸 CLI/웹소켓/다른 claude 세션에서 만지는 구조.

## 한눈에

```
 사람 (터미널)        브라우저 / 외부          다른 claude 세션 (마스터)
      │                    │                         │
  cardinal CLI    cardinal-server (Python)    cardinal CLI (Bash 도구)
      └──────────┬─────────┴─────────────────────────┘
                 ▼
          src/session.ts   ← 생성/조회/제어 공통 로직
            │         │
      tmux 명령     ~/.cardinal/sessions/<이름>/meta.json   (이름 ↔ instanceId)
            │       ~/.cardinal/hooks/<instanceId>/        (state.json · events.jsonl)
            ▼         ▲
   tmux 세션 cardinal-<이름>
     └─ claude (--session-id, --settings 훅) ── 훅 → dist/hook.js <훅 폴더> ─┘
```

CLI는 서버 없이 tmux랑 파일만 직접 만짐. 서버(`server/`, Python)는 CLI를 호출하고 파일을 DB로 모음 → [server.md](server.md).

## 파일 구성

| 파일 | 역할 |
| --- | --- |
| `src/paths.ts` | 경로 상수. `CARDINAL_HOME` (기본 `~/.cardinal`), tmux 접두사 `cardinal-` |
| `src/tmux.ts` | tmux 명령 얇은 래퍼 (has/list/kill, capture-pane, send-keys, paste) |
| `src/store.ts` | 세션 기록 파일 읽기/쓰기 |
| `src/hook.ts` | Claude Code 훅. 이벤트 받아서 상태 갱신 |
| `src/session.ts` | 생성, 상태 조회, send/keys/wait, report, kill |
| `src/transcript.ts` | 트랜스크립트(jsonl)를 턴 단위로 파싱 |
| `src/reply.ts` | `cardinal reply` (채널 이벤트에 답장, 서버로 전송) |
| `src/cli.ts` | `cardinal` 명령 |
| `bin/cardinal` | CLI 래퍼 스크립트 |

## 세션 만들기

`cardinal new <이름>` 하면 대충 이렇게 돌아감:

0. 작업 폴더: `--cwd <경로>` > **이 CLI를 부른 카디널 세션(마스터)의 작업 폴더** > 고정 워크스페이스 `$CARDINAL_WORKSPACE` (기본 `~/.cardinal/workspace`, 없으면 만듦). 마스터가 `cardinal new`로 워커를 띄우면 마스터 안의 `CARDINAL_SESSION`/`CARDINAL_INSTANCE` 환경변수로 부모를 알아내고 (그 세션 `meta.json`의 instanceId까지 맞아야 인정), 워커 `meta.json`에 `parent: {name, instanceId}`를 남김. `--cwd`를 주면 그 폴더 (있는 디렉터리여야 함, 상대 경로는 호출한 위치 기준). 어느 쪽이든 실제 경로(realpath)로 `meta.json`의 `cwd`에 기록. 경로 검사는 아래 3번에서 예전 기록을 지우기 **전에** 해서, 잘못된 경로를 줘도 같은 이름의 예전 기록은 그대로 남음.
1. 이름 검사 (`[A-Za-z0-9][A-Za-z0-9_-]{0,47}`).
   이후 단계는 전부 **이름별 생성 락**(`sessions/.create-<이름>.lock`, 최대 30초 대기) 안에서 함. 같은 이름 생성은 한 번에 하나씩.
   - 락 안에서 지금 세션 목록을 봄: 같은 이름이 살아 있으면 `이미 있는 세션: <이름> (<상태>)`, 카디널 기록 없이 같은 이름 tmux 세션만 있어도 `이미 있는 tmux 세션`으로 거부. 죽은 세션 기록만 남은 이름은 새로 만듦.
   - 락은 tmux가 뜬 다음에 풂 → 뒤에서 기다리던 같은 이름 요청은 목록에서 앞 세션을 보고 거부됨.
   - 락이 없을 땐 동시에 들어온 두 요청이 둘 다 확인을 통과해서, `meta.json`이 tmux 띄우기에 실패한 쪽 instanceId를 가리킨 채 남았음 (세션이 영원히 `starting`).
2. UUID 두 개 발급: **instanceId** (세션 고유 키, 훅 폴더 이름)와 처음 claude 세션 ID (`--session-id`로 넘김).
3. 같은 이름으로 남은 예전 기록(이름 폴더 + 그 이름이 가리키던 훅 폴더) 지우고,
   `hooks/<instanceId>/` 만들어서 `state.json(starting)` 쓰고, 마지막에 `sessions/<이름>/meta.json` 씀.
4. tmux 실행:
   ```
   tmux new-session -d -s cardinal-<이름> -c <작업 폴더> -x 200 -y 50 \
     "exec env CARDINAL_SESSION=<이름> CARDINAL_INSTANCE=<instanceId> CARDINAL_ROLE=<role> CARDINAL_HOME=... PATH=<repo>/bin:\$PATH \
        'claude' '--session-id' '<uuid>' '--name' '<이름>' '--settings' '<훅 JSON>' \
        '--append-system-prompt' '<역할 프롬프트>' [claude 인자...] [첫 프롬프트]"
   ```
   명령은 tmux 기본 셸이 `-c`로 돌리는 문자열 하나. 인자는 전부 작은따옴표로 감싸서 따옴표·`$`·백틱·줄바꿈이 그대로 감. 환경변수를 `new-session -e`가 아니라 `env`로 넣는 건 `-e`가 tmux 3.2+에만 있어서 (그 전 버전은 `unknown option -- e`로 실패). `exec`라 pane 프로세스는 바로 claude.
5. `window-size latest` 설정 → 여러 군데서 붙어도 마지막에 만진 쪽 크기 따라감.

4번 tmux 실행이 실패하면 3번에서 쓴 `meta.json`과 훅 폴더를 지우고 `tmux 세션 생성 실패: <tmux 에러>`로 끝냄 (안 뜬 인스턴스를 가리키는 기록이 안 남게).

claude가 종료되면 tmux 세션도 같이 사라짐.

### 작업 폴더와 기록 위치

- **기록 위치는 항상 고정**: `meta.json`(`$CARDINAL_HOME/sessions/<이름>/`)과 훅 폴더(`$CARDINAL_HOME/hooks/<instanceId>/`)는 작업 폴더와 상관없음. 서버가 보는 위치도 이것뿐. 작업 폴더엔 카디널 파일이 하나도 안 생김.
- **작업 폴더는 세션별**: 기본은 고정 워크스페이스, `--cwd`(API는 `cwd`, 절대 경로만)로 바꿀 수 있음. 마스터가 만든 워커는 `--cwd`가 없으면 마스터와 같은 폴더 (이미 신뢰한 폴더라 신뢰 다이얼로그도 안 뜸).
- 서버가 CLI를 부를 땐 `CARDINAL_SESSION`/`CARDINAL_INSTANCE`/`CARDINAL_ROLE`을 지우고 부름. 서버를 카디널 세션 안에서 띄웠어도 웹/API로 만든 세션이 그 세션의 폴더를 물려받지 않게.
- claude는 트랜스크립트를 `~/.claude/projects/<작업 폴더 경로에서 영숫자 아닌 건 전부 '-'>/<세션 ID>.jsonl` 에 씀 (`CLAUDE_CONFIG_DIR` 쓰면 그 아래). 카디널은 `meta.json`의 `cwd`(실제 경로)와 훅이 알려준 지금 세션 ID로 이 경로를 계산함 (`transcriptPath()` in `src/paths.ts`). 그래서 작업 폴더가 세션마다 달라도, `/tmp` 같은 심볼릭 링크 경로를 줘도, 세션이 죽은 뒤에도 찾을 수 있음.

### 신뢰 다이얼로그 (처음 쓰는 작업 폴더)

claude는 처음 보는 폴더에서 "이 폴더를 신뢰하냐" 다이얼로그를 띄움. 넘기기 전까지 세션은 `starting`.

- **감지**: 상태가 `starting`이면 화면에 그 다이얼로그가 떠 있는지 확인해서 `trustPrompt: true` + detail `작업 폴더 신뢰 다이얼로그 대기 (<경로>) — cardinal keys <이름> Down Enter`.
- **기다리지 않음**: 사람(또는 `--trust`)이 넘겨야 풀리니까 `new --wait`/`wait`는 바로 돌아오고(`new --wait`는 안내와 함께 exit 1), `send`는 바로 거부함. 서버 전달도 600초 `pending` 대신 즉시 `failed` + 이유.
- **`--trust`** (API `trust: true`): 만들 때 다이얼로그가 뜨면 "Yes, I trust this folder"로 넘김 (최대 20초 기다림, 생성 락 안에서). 명시적으로 줄 때만 동작.
  - 커서(`❯`)가 "Yes" 줄에 온 걸 화면으로 확인한 뒤에만 `Enter`, 아니면 `Down`을 다시 누름. 다이얼로그가 그려진 직후엔 키를 아직 안 받아서, 예전처럼 `Down`·`Enter`를 바로 보내면 `Down`이 씹히고 기본값 "No, exit"가 선택돼 claude가 꺼졌음 (Claude Code 2.1.309에서 3번 중 3번).
- 한 번 신뢰한 폴더는 claude가 기억해서 다음부턴 안 뜸. 기본 워크스페이스도 처음 한 번은 뜸.

### 훅 주입

`--settings`로 훅을 넣어서 사용자 설정 파일은 안 건드림 (기존 훅이랑 합쳐짐). 등록하는 이벤트:
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`.
명령은 `node <repo>/dist/hook.js <훅 폴더>`, 타임아웃 10초. **훅 폴더 경로가 명령 인자로 박혀 있음.**

훅은 **stdout에 절대 아무것도 안 찍음** (SessionStart/UserPromptSubmit 출력은 claude 컨텍스트에 들어가버려서). 에러 나도 항상 exit 0.

### 세션 고유 키와 훅 폴더

세션 하나(= claude 프로세스 하나)마다 **전용 훅 폴더가 하나**씩 있음. 훅은 그 폴더만 쓰고, 세션 이름은 모름.

```
~/.cardinal/
  sessions/<이름>/meta.json         카디널만 씀. 이름 → instanceId 연결은 여기서만
  hooks/<instanceId>/state.json     그 인스턴스의 훅만 씀
  hooks/<instanceId>/events.jsonl
```

- **훅 폴더는 띄울 때 훅 명령에 박힘.** 훅은 환경변수나 이름으로 폴더를 찾지 않음. 그 claude 프로세스는 평생 그 폴더만 씀.
- **이름 재사용**: `kill` 직후 같은 이름으로 `new` 하면 새 instanceId → 새 폴더. 이전 프로세스의 늦은 `SessionEnd`는 자기 옛 폴더로 가는데, `new`가 옛 폴더를 지웠으니 아무것도 안 씀. 예전엔 이게 새 세션 상태를 `ended`로 덮어썼음.
- **`/clear`**: claude 세션 ID는 바뀌지만 같은 프로세스라 같은 훅 폴더. 훅이 매번 받는 `session_id`를 `state.json`의 `claudeSessionId`에 적어둬서, 트랜스크립트도 최신 ID 기준으로 찾음. `meta.json`의 `claudeSessionId`는 처음 값 그대로 (`status`에선 `currentClaudeSessionId`로 지금 값을 같이 보여줌).
- **purge 뒤 늦은 훅**: 훅도 저장소도 폴더를 새로 만들지 않음. 폴더가 없으면 그냥 끝. 예전엔 meta 없는 폴더가 되살아났음.
- 서버 DB도 세션을 instanceId로 구분 (`sessions.id`). 지금 claude 세션 ID는 `claude_session_id` 칼럼.
- 예전 방식으로 만든 세션(meta에 `instanceId` 없음)은 이름 폴더를 같이 씀. 훅도 인자 없이 불리면 `CARDINAL_SESSION`으로 예전 폴더를 찾음.

### 역할 프롬프트

- 공통: "너는 카디널이 띄운 세션 `<이름>`, 레벨은 `<role>`", CLI 절대경로 알려줌.
- 마스터만: 작업 나눌 때 내장 서브 에이전트/워크플로 말고 `cardinal new ... --wait`로 워커 띄우라고 함. 사용자가 따로 요청하면 예외. send/ls/status/report/screen/keys/kill 사용법 포함.

CLI를 절대경로로 박는 이유: claude의 Bash 도구가 사용자 셸 프로필로 PATH를 다시 잡아서 tmux `-e PATH`가 안 먹음. 테스트 때 마스터가 `cardinal`을 못 찾았음.

## 상태

| 상태 | 뜻 | 찍는 이벤트 |
| --- | --- | --- |
| `starting` | tmux는 떴는데 claude 준비 전 (신뢰 다이얼로그 등) | 생성 시 카디널이 씀 |
| `idle` | 입력 대기 | `SessionStart`, `Stop`, `Notification(idle_prompt)`, 사람의 Esc 중단 (이벤트 `Interrupted`, 아래) |
| `busy` | 작업 중 | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` |
| `waiting` | 승인 같은 사람 손 필요 | 그 밖의 `Notification` |
| `ended` | 종료 | `SessionEnd`, `cardinal kill`, 또는 tmux 세션이 없으면 |

`PostToolUse`도 `busy`로 찍는 건 승인 후 `waiting`에서 다시 `busy`로 돌아오게 하려고.
단, 도구 이벤트는 이미 턴 안(`busy`/`waiting`)일 때만 반영함. `Stop` 뒤에 `PostToolUse` 없는 `PreToolUse`가 가끔 찍히는데
메인 트랜스크립트엔 흔적이 없음 (백그라운드 작업으로 추정). 이걸 받아주면 끝난 세션이 계속 `busy`로 보여서 막아둠.
턴은 항상 `UserPromptSubmit`으로 시작하니까 문제없음.
tmux가 죽었는데 훅이 못 찍은 경우도 조회할 때 `ended`로 보정.

### Esc 중단 = 사람이 개입한 것

사람이 Esc로 중단하면 `Stop` 훅이 안 와서 상태가 `busy`에 남음. 그 턴은 사람 손으로 넘어간 거라, 카디널은 거기서 손을 떼고 **사람에게 맡김**.

- 감지: 트랜스크립트 끝(뒤쪽 512KB)을 봐서, 마지막 사람 입력 뒤로 `[Request interrupted by user]` (도구 실행 중이면 `… for tool use]`)가 있고 그 시각이 훅 상태보다 늦으면 중단된 것.
- **응답 전 중단**: 응답이 한 글자도 나오기 전에 Esc를 누르면 트랜스크립트에 중단 표시가 **안 남고**, Claude Code가 그 프롬프트를 입력창에 되돌려 놓음 (실측). 그래서 화면으로도 판정: 작업 중이면 화면 맨 아래 줄에 `esc to interrupt`(좁으면 `esc to…`)가 떠 있음. 상태가 `busy`로 3초 넘게 그대로인데 맨 아래 3줄에 이게 없고, 0.8초 뒤 다시 봐도 훅이 새로 안 찍혔고 여전히 없으면 중단. 창 폭이 60칸 미만이면 안내가 잘릴 수 있어서 화면 판정은 안 함 (잘못 판정할 바엔 건너뜀). 정상 10초 작업 중 12번 조회해도 오판 0.
- **되돌아온 프롬프트 비우기**: 화면 판정으로 잡은 중단은 `restoredInput: true`를 같이 기록. 다음 `send`는 붙여넣기 전에 입력창을 비움 (`C-u`는 한 줄만 지워서 `BSpace`로 윗줄과 합치며 반복). 안 비우면 되돌아온 프롬프트와 새 메시지가 한 프롬프트로 합쳐짐.
- 처리: 상태를 `idle` + 이벤트 `Interrupted` + "사람이 중단함 (Esc)"로 봄. CLI가 조회할 때 `state.json`에도 적음 (그 사이 훅이 새로 썼으면 안 덮음). 서버 수집기도 같은 규칙으로 DB에 반영해서 아무도 CLI를 안 불러도 웹 UI에 보임.
- 결과: 기다리던 `send --wait`는 바로 끝나고 `interrupted: true` + 중단 전까지의 응답을 돌려줌 (실측: Esc 후 1초 안). 다음 `send`는 바로 들어감 (예전엔 idle 대기로 최대 600초 막혔음). `auto_reply`는 보내지 않고 전달 기록에 "사람이 중단함 (Esc) → 자동 답장 안 함". `report`의 phase는 `interrupted`.

### 기록 파일

- `sessions/<이름>/meta.json`: 만들 때 한 번 씀 (이름, **instanceId**, tmux 이름, role, cwd, 처음 claude 세션 ID, claude 인자, 생성 시각)
- `hooks/<instanceId>/state.json`: 훅이 계속 덮어씀 (state, 시각, 이벤트, detail, 마지막 도구, transcript 경로, 지금 claude 세션 ID)
- `hooks/<instanceId>/events.jsonl`: 훅 이벤트 전부 한 줄씩 추가 (프롬프트는 2000자, 도구 입력은 300자까지만, `prompt_id`, claude 세션 ID 포함)

meta랑 훅 파일은 쓰는 쪽이 달라서 (카디널 vs 훅) 폴더부터 나눠둠. 쓸 때는 tmp 파일에 쓰고 rename.

## 제어

### send

같은 세션에 들어가는 `send`는 전부 **한 줄로 섬** (CLI 여러 개, 서버, 마스터 세션 다 포함). `src/session.ts`의 `send`, 락은 `src/lock.ts`.

0. **크기 확인**: 텍스트가 16,000바이트를 넘으면 바로 거부 (tmux 한도, [안내](#알려진-문제--할-것)).
1. **세션 락 잡기**: 훅 폴더의 `send.lock`. 다른 `send`가 붙여넣기~Enter 하는 중이면 기다림.
   - 락 파일 내용은 `<pid> <잡은 시각 ms>`. 잡고 있던 프로세스가 죽었거나 **30분 넘게** 잡혀 있으면 죽은 락으로 보고 치움 (pid가 다른 프로세스에 재사용돼서 살아 보이는 경우도 결국 풀림).
   - 치우기 직전에 내용을 다시 읽어서, 그 사이 남이 새로 잡은 락은 안 지움. 풀 때도 내 락일 때만 지움.
   - 내용을 tmp 파일에 먼저 쓰고 `link`로 락 파일을 만들어서, 빈 락 파일이 보이는 순간이 없음.
   - 예전 형식(pid만 있는 락)도 읽음.
2. **idle 대기**: 세션이 `busy`/`starting`이면 idle 될 때까지 기다림 (기본 최대 600초, `--queue-timeout`).
   - 이유: 작업 중에 보낸 메시지는 대기열에 안 쌓이고 **진행 중인 턴에 바로 끼어듦**. 실측: busy 중에 보낸 2개 → `UserPromptSubmit` 3번, `Stop` 1번. 그러면 메시지 하나 = 턴 하나가 안 돼서 `--wait`/`auto_reply`가 남의 답을 가져감.
   - `--now`: 안 기다리고 바로 넣음 (일부러 끼워넣고 싶을 때).
3. 대상이 `waiting`이면 거부 (다이얼로그에 텍스트가 들어가니까). `--force`로 무시 가능.
4. **막 뜬 세션이면 잠깐 대기**: 상태가 `SessionStart`로 idle이 된 지 1.5초가 안 됐으면 1.5초까지 기다림. `SessionStart` 훅 직후엔 claude 화면이 아직 입력을 못 받아서 Enter가 먹힘 (실측: 세션 4개를 동시에 띄우고 바로 이벤트를 넣었을 때 텍스트가 입력창에 남은 채 멈춤).
5. 보내기 직전 트랜스크립트의 턴 개수를 기억 (= 이 메시지가 만들 턴의 위치).
6. `tmux set-buffer` → `paste-buffer -p` (bracketed paste). `send-keys`로 보내면 줄바꿈에서 엔터로 먹혀서 이렇게 함.
7. 200ms 쉬고 `Enter`. 바로 치면 TUI가 가끔 삼킴. `--no-enter`면 붙여넣기만 (락도 바로 풂).
8. **받았는지 확인 + Enter 재시도**: 훅 상태가 보낸 시각 이후로 바뀌는지 3초 동안 봄 (50ms 간격). 안 바뀌면 Enter를 다시 누르고 또 3초, **최대 3번** (Enter가 먹혔으면 텍스트가 입력창에 남아 있으니까). 이미 받았는데 훅만 늦은 거면 빈 입력창에 Enter라 아무 일도 안 일어남. 그래도 못 보면 `accepted: false`.
   - `--wait`인데 `accepted: false`면 턴을 기다리지 않고 바로 실패 (exit 1, `--json`이면 결과 JSON도 먼저 찍음). 예전엔 안 들어간 메시지의 턴을 `--timeout`까지 기다렸음.

동시에 들어온 `send`의 순서는 락을 먼저 잡은 순서.

### keys

`tmux send-keys` 그대로. 신뢰 다이얼로그 (`Down Enter`), 승인 선택지, `Escape`, `C-c` 같은 거.

### wait

0.5초마다 상태 파일 확인. 기본은 `idle`/`waiting`/`ended` 중 하나 되면 끝.
`send --wait`는 보낸 시각 이후에 찍힌 상태만 인정해서, 보내자마자 아직 `idle`인 걸 끝난 걸로 착각하지 않음.
끝나면 마지막 턴이 아니라 **5단계에서 기억한 위치의 턴** (= 자기가 만든 턴) 답을 출력함. 끝난 직후 다른 `send`가 다음 턴을 시작해도 남의 답을 안 가져감. `/clear` 등으로 트랜스크립트가 바뀌었으면 마지막 턴.
- **Stop 뒤 트랜스크립트 기다림**: `Stop` 훅은 마지막 답 줄이 트랜스크립트 파일에 쓰이기 **전에** 옴 (실측: 파일에 나타나는 게 `Stop`보다 80~130ms 늦음). 바로 읽으면 마지막 답을 놓쳐서 `auto_reply`가 빈 답이 됐었음. 그래서 그 턴이 `end_turn`으로 끝났다고 기록될 때까지 최대 5초 더 봄. `waiting`으로 멈춘 턴은 안 기다리고 지금까지의 걸 돌려줌.
- **시간 초과**: `--timeout` 안에 안 끝나면 실패가 아니라 "메시지는 들어갔는데 아직 안 끝남". `--json`이면 `timedOut: true` + 지금까지의 부분 응답으로 exit 0, 텍스트 모드면 부분 응답 출력 후 exit 1.
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
   | `interrupted` | `idle`인데 사람이 Esc로 중단함 (턴은 안 끝남) |

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

`src/transcript.ts`가 이걸 턴으로 묶음. `user` 줄이라고 다 사람 입력이 아니라서 종류를 나눔 (전부 실측으로 확인):

| `user` 줄 | 구분 | 처리 |
| --- | --- | --- |
| 사람 입력, `send`로 붙여넣은 것 | `origin.kind: "human"` | **턴 시작** |
| 백그라운드 작업 완료 알림 `<task-notification>…` | `origin.kind: "task-notification"` | claude가 스스로 시작한 턴. 사람 턴으로 안 세고, 그 답이 앞 사람 턴에 섞이지 않게 끊음 |
| `[Request interrupted by user]` (`… for tool use]`) | origin 없음 | 진행 중이던 사람 턴을 `interrupted`로 끝냄 |
| `/clear`·`/compact` 명령 줄, 명령 출력, 압축 요약 | origin 없음 | 무시 (턴을 끊지도 않음. 턴 도중 자동 압축 뒤 이어지는 답은 같은 턴) |
| `tool_result`, `isMeta`, `isSidechain` | | 무시 |

- `origin` 필드가 없던 예전 버전 트랜스크립트는 내용 패턴(`<command-name>`, `<local-command-`, `<task-notification>`, `This session is being continued` 등)으로 구분.
- 턴 시작 뒤 `assistant` 줄의 text 블록 전부 → `texts` (중간 보고 포함), tool_use → `tools`
- 마지막 `assistant` 줄의 `stop_reason`이 `end_turn`이면 `complete`
- 예전엔 사람 입력이 아닌 줄도 전부 턴 시작으로 봐서, `/clear`·`/compact` 뒤에 `last`가 비거나, 백그라운드 알림에 대한 답이 "마지막 턴"으로 나왔음. 실제 트랜스크립트로 확인: 명령/요약/알림 줄이 섞인 파일에서 예전 9턴 → 지금 사람 턴 1개. 백그라운드 알림 턴이 생겨도 `last`/`report`는 사람 턴의 답을 보여주고, 다음 `send --wait`도 자기 턴을 정확히 고름.

작업 중일 때 report 하면 지금까지 쓴 부분 응답이 나오고 "아직 진행 중" 표시가 붙음. 세션이 죽은 뒤에도 트랜스크립트는 남아 있어서 report 됨.
`last`는 같은 파싱 결과에서 마지막 턴 텍스트만 출력함. `send --wait`는 같은 파서로 자기가 만든 턴을 골라 출력함.

## CLI

```
cardinal new <이름> [--role worker|master] [--cwd DIR] [--trust] [--prompt TEXT] [--wait] [-- claude 인자...]
cardinal ls [--json]
cardinal status <이름> [--json]
cardinal send <이름> <텍스트|-> [--wait] [--timeout 초] [--no-enter] [--force]
cardinal keys <이름> <키...>
cardinal wait <이름> [--timeout 초]
cardinal screen <이름> [--lines N]          # Claude Code 는 대체 화면이라 tmux 스크롤백이 거의 없음
cardinal report <이름> [--tools] [--json]
cardinal last <이름>
cardinal attach <이름>
cardinal kill <이름> [--purge]
cardinal reply <이벤트ID> <텍스트|-> [--file 경로]...
```

`new`/`send`/`kill`은 `--json` 주면 결과를 JSON으로 (서버가 이걸 씀).

## 서버

HTTP/웹소켓, DB, 메시지 채널은 Python 서비스로 분리됨 → [server.md](server.md).

## 테스트해본 것

- 워커 생성 → 파일 쓰기 지시 → `send --wait`로 응답 받기. 이벤트 `SessionStart → UserPromptSubmit → PreToolUse(Bash) → PostToolUse → Stop` 확인.
- 여러 줄 메시지 (bracketed paste).
- 마스터가 알아서 워커 띄우고 → 답 받고 → kill.
- `report`: 작업 중엔 `working` + 부분 응답, 끝나면 `done` + 중간 보고까지 포함한 전체 응답, kill 뒤엔 `dead` + 기록. 마스터가 `report`로 워커 응답 전체를 받아옴.
- 계산한 트랜스크립트 경로 = 훅이 알려준 경로 (일치 확인).

## 알려진 문제 / 할 것

- 작업 폴더를 처음 쓸 때 신뢰 다이얼로그 때문에 `starting`에서 멈춤 → 감지해서 바로 알려줌. `--trust`로 만들거나 `cardinal keys <이름> Down Enter` ([신뢰 다이얼로그](#신뢰-다이얼로그-처음-쓰는-작업-폴더)).
- `waiting` 상태는 실제로 못 띄워봄 (테스트 세션이 auto mode라 승인 프롬프트가 안 뜸).
- `Stop` 뒤 정체불명 `PreToolUse`는 막아뒀지만 정체는 아직 모름. `events.jsonl`의 `promptId`로 추적 가능.
- `cardinal kill`은 tmux만 죽이고 바로 끝남. `SessionEnd` 훅(reason `other`)은 그 뒤에 늦게 뜸. 카디널도 `ended`를 직접 씀.

동시성 / 훅 분석에서 확인된 것 (실제 재현):

- **같은 세션 안 동시 훅끼리 `state.json` 덮어쓰기.** 병렬 도구 호출이면 훅 프로세스가 같은 밀리초에 뜸 (`PreToolUse` 3개 동시 확인). 거의 동시에 시작한 두 훅은 어느 쪽이 이길지 정해져 있지 않음. 승인 대기 중인데 `busy`로 보일 수 있음 (원리만 재현, 실제 승인 창으로는 미확인).
- **`/clear` 직후 약 50ms `ended`.** `SessionEnd(clear)` → `SessionStart(clear)` 순서로 와서.
- **백그라운드 작업이 끝나면 claude가 스스로 턴을 시작함** (`<task-notification>` 입력). 그동안 상태는 `busy`(실제로 일하는 중이니 맞음). 그 턴의 답은 `report`/`last`에 안 나옴 (사람 턴만 보여줌).
- 추정 (미확인): 턴 도중 자동 압축이 일어나면 `SessionStart(compact)` 때문에 그 턴 끝까지 `idle`로 보일 것. `auth_success` 같은 알림 타입도 `waiting`으로 잘못 찍힐 것.

안내 (문제 아님):

- **한 번에 보낼 수 있는 텍스트는 16,000바이트까지.** tmux가 명령 하나로 받는 크기 한도라서 따름 (실측 한계 16,343바이트, tmux 3.6a). 넘으면 tmux에 넘기기 전에 `보낼 텍스트가 tmux 한 번 전달 한도를 넘음: N바이트 > 16000바이트 (tmux 제약)`으로 바로 거부. 한글은 글자당 3바이트라 약 5,300자. 긴 내용은 파일로 저장하고 경로를 보낼 것.

해결된 것:
- 이름 재사용 시 이전 세션 훅의 오염, `/clear` 뒤 옛 트랜스크립트 읽기, purge 뒤 폴더 되살아남 → 세션별 훅 폴더 ([세션 고유 키와 훅 폴더](#세션-고유-키와-훅-폴더)).
- 동시 `send`가 한 입력으로 합쳐짐 (0.2초 이하 간격이면 항상 `firstsecond`처럼 합쳐졌음), 작업 중에 보낸 메시지가 진행 중인 턴에 끼어듦 → 세션 락 + idle 대기 ([send](#send)). 실제 claude에서 이벤트 2개를 0.1초 간격으로 넣어도 턴 2개로 따로 처리되고, 자동 답장도 각자 맞게 감.
- Esc 중단 뒤 `busy`에 멈춰 `wait`/`send`가 막힘 → 사람 개입으로 처리 ([Esc 중단](#esc-중단--사람이-개입한-것)).
- 트랜스크립트 파서가 명령 줄·압축 요약·백그라운드 알림을 턴으로 봄 → 사람 입력만 턴 ([report](#report-결과-보고)).
