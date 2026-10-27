# 카디널 MCP

[English](mcp.en.md) · 관련: [서버](server.md), [세션 시스템](session-system.md), [SDK 모드](sdk-mode.md)

**카디널 서버가 떠 있으면, 세션 안 모델은 카디널을 MCP 도구(`mcp__cardinal__*`)로만 다룸.** tmux + Claude Code 세션이든 SDK 세션이든 같은 서버의 같은 MCP를 씀. `cardinal` CLI는 그대로 남지만 사람이 직접 개입할 때용.

## 왜 바꿨나

예전엔 두 갈래였음.

- tmux 세션: 시스템 프롬프트에 CLI 절대경로와 사용법을 박고, 모델이 Bash로 `cardinal new/send/reply …`를 부름
- SDK 세션: 서버 프로세스 안 MCP 서버(`create_sdk_mcp_server`)로 도구를 줌

그래서 도구 구현이 둘이고, 둘 다 "프롬프트에 쓴 대로 해 주길" 기대는 방식이었음. 워커도 CLI를 부르면 세션을 만들 수 있었고, 부른 세션이 누군지도 환경변수(`CARDINAL_SESSION`)로만 알았음.

지금은:

- 도구는 서버의 `server/cardinal_server/mcp_server.py` 한 곳. 두 백엔드가 같은 도구를 씀
- 역할별 도구 목록을 서버가 정함: 워커는 마스터 전용 도구(만들기·정리·화면·키·질문 답)가 아예 안 보임
- 부른 세션은 요청마다 키로 확인 (환경변수 아님)
- 사용법은 도구 설명에 있어서 프롬프트가 짧아짐

## 구조

```
                    cardinal-server (FastAPI)
                     └ /mcp  ── CardinalMcp.app
                          ├ /mcp/worker  → MCPServer "cardinal" (reply, session_list, session_send/wait/report → 있는 워커만, drive_*)
                          └ /mcp/master  → MCPServer "cardinal" (위 + session_new/kill/screen/keys/answer, 누구든 부름)
                               ▲ X-Cardinal-Instance / X-Cardinal-Key 확인 (401 / 403)
              ┌────────────────┴────────────────┐
   tmux claude (CLI 가 띄움)               SDK 세션 (서버 안)
   --mcp-config '{"mcpServers":{"cardinal":  mcp_servers={"cardinal":
     {"type":"http","url":…,"headers":…}}}'    {"type":"http","url":…,"headers":…}}
   --allowedTools mcp__cardinal            allowed_tools=[…, "mcp__cardinal"]
```

- MCP는 streamable HTTP, **stateless** (요청마다 독립). 서버가 다시 떠도 세션 쪽 연결 상태가 꼬이지 않음.
- `/mcp/worker`, `/mcp/worker/` 둘 다 받음 (`Mount`가 끝 `/`를 요구해서 앞에 작은 디스패처를 둠).
- 웹 UI 전체 받기 라우트(`/{path}`)보다 먼저 붙임. 안 그러면 `/mcp/...`가 그쪽으로 빠짐 (실측: 405).

## 도구

| 도구 | 워커 | 마스터 | 하는 일 |
| --- | :-: | :-: | --- |
| `reply(event_id, text, files[])` | ✓ | ✓ | 채널 이벤트에 답장. files는 작업 폴더 기준 상대 경로 가능, 최대 10개·각 10MB |
| `session_list()` | ✓ | ✓ | 세션 목록 (이름, 역할, 방식, 상태, 작업 폴더, 만든 세션) |
| `drive_list` `drive_read` `drive_write` `drive_move` `drive_delete` | ✓ | ✓ | 웹드라이브 파일 다루기 (목록, 글 읽기/쓰기, 옮기기, 지우기). 경로를 `/` 없이 쓰면 내 세션 폴더 기준 → [웹드라이브](drive.md) |
| `drive_upload(src, path?, keep_source?)` / `drive_load(path, dest?)` | ✓ | ✓ | 로컬 → 드라이브로 옮기기 / 드라이브 → 로컬로 복사 |
| `session_new(name, prompt?, role?, cwd?, backend?, wait?, timeout_s?, attachments?)` | | ✓ | 워커 만들기. cwd·backend 기본은 부른 세션과 같게. 부모 기록 |
| `session_send(name, text, wait=true, timeout_s?, now?, attachments?)` | ✓* | ✓ | 지시 보내기 (작업 중이면 끝난 뒤 차례로). `attachments`: 넘길 드라이브 파일 |
| `session_wait(name, timeout_s?)` | ✓* | ✓ | 지금 일이 끝날 때까지 기다리고 결과 보고. 질문/권한 대기에 걸리면 바로 |
| `session_report(name)` | ✓* | ✓ | 살아있나, 작업중/완료/중단, 마지막 사람 턴 전체, 답 기다리는 질문(SDK) |
| `session_kill(name, purge?)` | | ✓ | 끝내기 |
| `session_screen(name, lines?)` | | ✓ | tmux 세션 화면 (승인 다이얼로그 확인) |
| `session_keys(name, keys[])` | | ✓ | tmux 세션에 키 (다이얼로그 처리) |
| `session_answer(name, pending_id, answers?, allow?, message?)` | | ✓ | SDK 세션의 질문/권한에 답 |

- 자기 자신에게 send/wait/kill/keys는 막음.
- **워커 규칙 (✓\*)**: 워커는 새 세션을 못 만듦(`session_new` 없음). 대신 **이미 있는 워커**에게 `session_send`/`session_wait`/`session_report`로 일을 맡기고 결과를 받을 수 있음. 상대가 마스터거나 없는 세션이면 거부 (`워커는 마스터를 부를 수 없음`, `모르는 세션 … 워커는 새 세션을 못 만듦`). 마스터는 워커·마스터 누구든 부름.
- **교착 막기**: 누가 누구의 응답을 기다리는지(`session_send wait=true`, `session_wait`) 서버가 기억하고, 기다림이 돌고 돌아 자기에게 오면 거부함. 예: w1이 w2를 wait로 부른 턴 안에서 w2가 w1에게 wait로 보내면, w1은 그 턴이 안 끝나서 둘 다 시간 끝까지 멈춤 → `교착: w1 이(가) 이미 너(w2)의 응답을 기다리는 중…`. `wait=false`는 안 막음.
- 기다리는 도구(`session_send wait`, `session_wait`, `session_new wait`)는 최대 3600초. 세션 쪽 MCP 타임아웃은 `MCP_TOOL_TIMEOUT=3700000`(ms)으로 넉넉히 줌 (tmux는 env, SDK는 `env`).
- 도구는 다 서버의 `Sessions`(백엔드 고르기)를 부름. 그래서 tmux 마스터가 SDK 워커를, SDK 마스터가 tmux 워커를 만들어도 됨.

## 누가 불렀는지

- 서버 비밀 키: `~/.cardinal/mcp.key` (서버가 처음 뜰 때 만듦, 0600)
- 세션 키: `HMAC-SHA256(비밀 키, instanceId)`. 헤더 `X-Cardinal-Instance: <instanceId>`, `X-Cardinal-Key: <키>`
- 서버는 요청마다 키를 다시 계산해서 비교 → 세션 행을 찾음 (막 뜬 tmux 세션이 아직 DB에 없으면 수집 한 번 더). 지워진 세션이면 401, 워커가 `/mcp/master`를 부르면 403.
- DB에 세션별 토큰을 저장하지 않아도 되고, CLI도 같은 키 파일로 키를 만들 수 있음.
- 같은 OS 사용자면 키 파일을 읽을 수 있음. 이건 "어느 세션이 불렀나 / 무슨 역할이냐"를 정하는 장치지, 같은 사용자 안의 보안 경계는 아님.
- `CARDINAL_TOKEN`(웹/API 토큰)과는 따로. `/mcp`는 세션 키로만 들어옴.

## 세션에 붙이기

### tmux 세션 (`cardinal new`)

`src/session.ts` `mcpAttach()`:

1. 서버 주소: `CARDINAL_SERVER_URL`(서버가 CLI를 부를 때 넣어 줌) → 없으면 `~/.cardinal/server.json`
2. `~/.cardinal/mcp.key`가 있고 `/api/health`가 1.5초 안에 답하면(200/401) 붙임
3. claude 인자 앞쪽에 `--mcp-config <JSON> --allowedTools mcp__cardinal` (둘 다 값을 여러 개 받는 옵션이라, 끝에 두면 첫 지시를 값으로 먹음)
4. 시스템 프롬프트는 MCP용 (아래), `meta.json`에 `"mcp": true`, env `MCP_TOOL_TIMEOUT=3700000`

서버가 없거나 `--no-mcp`면 예전 그대로: CLI용 프롬프트, `mcp: false`. 사람이 서버 없이 CLI만 쓰는 경우.

서버가 마스터 도구로 만들 때 부모는 env `CARDINAL_PARENT_NAME` / `CARDINAL_PARENT_ID`로 CLI에 넘김 (SDK 마스터는 meta 파일이 없어서 env 말고는 못 넘김). 예전엔 SDK 마스터가 만든 tmux 워커는 부모 기록이 빠졌음.

### SDK 세션

`sdk.py` `_build_options()`가 `mcp_servers["cardinal"]`에 같은 HTTP 설정을 넣음 (`mcp_server.mcp_config()`). 프로세스 안 MCP 서버는 없앰.

`resume_on_start` 세션은 서버가 요청을 받기 시작한 뒤에 띄움 (`resume_when_serving`). lifespan 시작 단계에선 아직 `/mcp`가 안 받아서, 그때 띄우면 카디널 도구 연결이 실패함.

### 프롬프트

MCP 세션의 프롬프트 (tmux는 `src/session.ts` `MCP_*_PROMPT`, SDK는 `sdk.py` — 같은 내용):

- 공통: "카디널은 `mcp__cardinal__*`로만 다룬다. CLI는 사람용이니 Bash로 부르지 마라", `[cardinal:event <ID>]`는 외부 이벤트고 답은 `mcp__cardinal__reply`로만 전달됨
- 워커: 새 세션은 못 만들고, 있는 워커에게 `session_send`/`session_wait`/`session_report`로 맡김 (마스터는 못 부름). 다른 세션 드라이브 폴더도 읽고 씀
- 마스터: 내장 서브 에이전트 대신 `session_new`로 워커, `session_send`/`session_wait`/`session_report`, 막히면 `session_screen`+`session_keys`(tmux) / `session_answer`(SDK), `session_kill`

채널 전달 메시지 끝의 답장 안내도 세션에 맞춰 나감: `sessions.mcp`가 켜진 세션(SDK는 항상)은 `mcp__cardinal__reply`, 아니면 `cardinal reply …`.

## 서버가 다시 뜰 때

- **tmux claude는 끊긴 MCP 서버를 스스로 다시 붙지 않음** (실측: 서버를 껐다 켜면 도구가 사라진 채로 남고, 다시 물어도 "연결 안 됨").
- 그래서 서버가 요청을 받기 시작하면, 살아있는 tmux 세션 중 `mcp`인 것마다 `cardinal mcp-reconnect <이름>`을 부름:
  - send와 같은 세션 락으로 줄을 서고, 작업 중이면 끝날 때까지 기다림
  - 입력창에 `/mcp reconnect cardinal` + Enter (메뉴 없이 바로 됨, 실측)
  - 화면에 "Successfully reconnected to cardinal"이 새로 뜨면 성공
- SDK 세션은 서버와 같이 끝나고 다시 뜨면서 새로 붙으니 따로 할 일 없음.
- 서버가 꺼져 있을 때 만든 tmux 세션은 CLI 방식(`mcp: false`) 그대로. 나중에 서버가 떠도 MCP로 안 바뀜.

## 종료

- 서버 → 세션 알림 스트림(`GET` SSE)은 안 씀. `GET`엔 405.
  - 열어 두게 하면 claude들이 그 연결을 계속 잡고 있음. 그러면 uvicorn이 종료 때 그 연결이 닫히길 기다리다 SDK 세션 정리(lifespan 종료)까지 못 가고 멈춤 (실측: SIGTERM 뒤 몇 분 동안 안 꺼짐. SDK claude가 그 연결을 잡고 있는데, 그 claude를 끄는 게 lifespan 종료라 서로 기다림).
- `timeout_graceful_shutdown=5`: 오래 걸리는 MCP 호출(`session_wait` 등)이나 클라이언트가 열어 둔 POST 스트림이 있어도 5초 뒤 끊고 정리로 넘어감. 지금은 종료에 6초 정도.

## 확인한 것

scratch 서버(`--sdk`, 모델 haiku)로:

- `/mcp/worker`, `/mcp/worker/`, `/mcp/master` 키 없으면 401, 모르는 경로 404. MCP 클라이언트로 워커 키 → 도구 2개, 같은 키로 `/mcp/master` → 403
- API로 만든 tmux 워커: `meta.mcp=true`, 권한 확인 없이 `mcp__cardinal__session_list` 호출
- tmux 마스터가 `session_new`로 tmux 워커 + SDK 워커를 만들고 `wait`로 각자 답("apple", "banana") 회수, 둘 다 `parent=tm1`
- SDK 마스터가 tmux 워커를 만들고 `session_send(wait=false)` → `session_wait` → `session_report` → `session_kill(purge)`. 워커 `parent=sm1`
- local 채널 이벤트 → tmux 워커가 `mcp__cardinal__reply`로 "5" 답장 (`source: tool`)
- 서버 없이 `cardinal new` → `mcp: false`(CLI 방식) / 서버 있을 때 `new` → `true`, `--no-mcp` → `false`
- 서버 재시작: `resume_on_start` SDK 마스터가 다시 떠서 카디널 MCP connected(도구 10개), tmux 세션 3개 자동 `/mcp reconnect` → 다시 도구 호출됨
- 종료: `GET` 막기 전엔 SIGTERM 뒤 몇 분째 안 꺼짐(위 원인) → 막은 뒤 6초

## 알아둘 것

- 서버가 꺼진 동안 tmux 세션이 카디널 도구를 부르면 실패함 (연결 거부). 다시 뜨면 위처럼 다시 붙음.
- 처음 뜰 때 MCP 연결에 실패한 세션(예: 그때 서버가 이상했음)은 서버 재시작 때의 `mcp-reconnect`로 다시 붙거나, 사람이 `cardinal mcp-reconnect <이름>`.
- haiku는 도구 인자를 가끔 틀림 (`backend`를 빠뜨려 SDK 워커가 뜸, `text` 대신 `message`). 에러를 보고 스스로 고침.
- SDK 쪽 경고 `CanUseToolShadowedWarning: can_use_tool will not be invoked for: mcp__cardinal`은 의도한 것 (카디널 도구는 묻지 않음).
- 아직 안 해본 것: 10분 넘게 걸리는 `session_wait` 실제 호출, 디스코드 실제 봇.
