# SDK 모드

[English](sdk-mode.en.md) · 관련: [서버](server.md), [세션 시스템](session-system.md)

tmux + Claude Code TUI 대신, **서버 프로세스 안에서 Claude Agent SDK(`claude-agent-sdk`, Python)로 세션을 직접 돌리는** 모드. 화면을 긁거나 키를 누르지 않고 메시지를 주고받으니까, 음성 인식/합성·모션 같은 프로그램이 붙기 좋음.

- 세션은 서버와 같이 삶. 서버가 꺼지면 세션도 끝나고, `restart`로 대화를 이어서 다시 띄움 (`resume_on_start`면 서버 켜질 때 자동)
- CLI(`cardinal ...`)로는 안 다룸. **FastAPI(REST + 웹소켓)로만** 만들고 보내고 받음
- 채널(디스코드, local)과 라우트는 tmux 세션과 **같은 것**을 그대로 씀. 이벤트 전달, 자동 답장, 직접 답장 다 됨
- 기본 권한 모드는 `auto`. 질문(AskUserQuestion)·권한 확인은 사람한테 넘겨서 API로 답을 받음

## 켜기

```sh
cd server && uv run cardinal-server --sdk      # 또는 CARDINAL_SDK=1
./launch.sh --sdk                              # 서버 + 웹 UI
```

`--sdk`면 새 세션의 기본 백엔드가 `sdk`. tmux 세션도 같이 쓸 수 있음 (`"backend": "tmux"`). `--sdk` 없이 띄운 서버는 SDK 세션을 새로 못 만듦 (예전 기록 조회·정리는 됨). `GET /api/health`의 `sdk.enabled`로 확인.

claude 로그인은 이 컴퓨터의 Claude Code 로그인 그대로 씀 (SDK가 claude CLI를 같이 들고 옴).

## 세션 만들기

```http
POST /api/sessions
{
  "name": "voice",
  "role": "worker",                 // master 면 워커를 띄우는 도구 안내가 붙음
  "cwd": "/abs/path",               // 없으면 고정 워크스페이스 (~/.cardinal/workspace)
  "prompt": "첫 지시 (선택)",
  "backend": "sdk",                 // --sdk 서버면 생략 가능
  "routes": [{"platform": "local", "channel": "voice", "match": "prefix", "trigger": "!v", "auto_reply": true}],
  "sdk": {
    "permission_mode": "auto",      // default | acceptEdits | plan | dontAsk | bypassPermissions | auto
    "model": "sonnet", "fallback_model": null, "effort": null,
    "append_prompt": "추가 시스템 프롬프트",
    "mcp_servers": {
      "tts": {"type": "stdio", "command": "/usr/bin/python3", "args": ["tts_mcp.py"], "env": {"KEY": "..."}},
      "web": {"type": "http", "url": "https://...", "headers": {"Authorization": "Bearer ..."}}
    },
    "strict_mcp_config": false,     // true 면 위 mcp_servers(+ cardinal)만. 사용자/프로젝트/claude.ai 커넥터/플러그인 MCP 안 붙음
    "allowed_tools": [], "disallowed_tools": [], "add_dirs": [], "env": {},
    "partial": false,               // true 면 토큰 단위 StreamEvent 를 /ws/sdk 로 (음성 합성용)
    "max_turns": null, "max_budget_usd": null, "setting_sources": null,
    "question_timeout_s": null,     // 질문/권한에 이 시간 안에 답이 없으면 "스스로 판단해서 진행" 으로 돌려줌
    "resume_on_start": false        // 서버 재시작 때 이어서 자동으로 띄움
  }
}
```

- 이름 규칙은 tmux 쪽과 같음 (영문/숫자/-/_, 48자). 이름은 두 백엔드가 같이 씀: tmux 세션이 쓰는 이름(기록 포함)은 SDK로 못 만들고, 살아있는 SDK 세션 이름은 tmux로 못 만듦. 끝난 세션 이름은 넘겨받고 예전 기록은 삭제 표시로 남음.
- 세션 목록/상세에서 `sdk_options`의 `env`, MCP `env`/`headers` 값은 `***`로 가림 (DB에는 원본 저장: restart 때 다시 써야 해서).
- 새 세션은 0.7초 정도면 `idle` (신뢰 다이얼로그 없음).

## 공통 API (tmux 세션과 같은 것)

| API | SDK 세션에서 |
| --- | --- |
| `GET /api/sessions`, `GET /api/sessions/<이름>` | `backend: "sdk"`, 상세엔 `pending`(답 기다리는 질문) 추가 |
| `POST …/send` | `text`, `wait`, `timeout_s`, `now`, `force` 그대로. `submit: false`(붙여넣기만)는 입력창이 없어서 400 |
| `GET …/report` | 같은 모양 (`status`, `phase`, `turn`) + `pending` |
| `GET …/events` | 훅 이벤트 기록 (SDK 훅 콜백으로 받음) + `Result`, `Question`, `Answered`, `SessionStart/End` |
| `DELETE /api/sessions/<이름>?purge=` | 세션 끝내기. purge면 삭제 표시 |
| 라우트, 채널, `POST /api/events/<id>/reply` | 그대로 |
| `…/screen`, `…/keys`, `/ws/term` | tmux 전용이라 400 / 4400 |

send 규칙도 tmux와 같음: 세션마다 한 줄로 서고, 작업 중이면 idle 될 때까지 기다렸다가 보냄. 작업 중에 넣으면 SDK도 진행 중인 턴에 끼워 넣어서 응답이 하나로 합쳐지기 때문 (실측). `now: true`면 안 기다리고 끼워 넣음 (그 턴과 같은 결과를 받음). 질문/권한 답을 기다리는 중(`waiting`)엔 `force` 없이는 거부.

`wait: true`의 응답: `{sentAt, accepted, timedOut, interrupted, status, last}`. `last`는 이 메시지가 만든 턴의 텍스트 전체. tmux와 달리 질문 대기 중에도 턴이 끝날 때까지 기다림 (질문은 턴의 일부라서).

## SDK 전용 API

| API | 하는 일 |
| --- | --- |
| `POST …/interrupt` | 작업 중인 턴 중단 (tmux의 Esc). 기다리던 질문은 거부로 풀림. 그 턴은 `interrupted`, 상태 `idle`/`Interrupted` |
| `POST …/restart` `{resume: true, sdk: {...}}` | 다시 띄우기. 기본은 마지막 대화 이어서. `sdk`에 바꿀 옵션만 주면 나머지는 그대로 (MCP 서버 추가 등) |
| `GET …/pending` | 답 기다리는 질문/권한 목록 |
| `POST …/pending/<id>` | 답하기. 질문: `{"answers": {"질문 텍스트": "고른 라벨 또는 자유 입력"}}`. 권한: `{"allow": true}` / `{"allow": false, "message": "이유"}` (+ `updated_input`). 질문에 `allow: false`면 "답 안 함, 스스로 판단" |
| `GET …/mcp` | MCP 서버 상태 (연결/실패/인증 필요, 도구 목록) |
| `POST …/mcp/<서버>` `{action}` | `reconnect` / `enable` / `disable` |
| `POST …/model` `{model}` | 모델 바꾸기 (다음 restart에도 유지) |
| `POST …/permission-mode` `{mode}` | 권한 모드 바꾸기 (유지) |
| `GET …/context` | 컨텍스트 사용량 (`/context`와 같은 정보) |
| `GET …/turns?limit=` | 턴 기록 (DB `sdk_turns`). `origin`: human(보낸 것) / agent(백그라운드 작업 알림 등) |

## 실시간 연결 `/ws/sdk/<이름>`

프로그램이 붙는 곳. 연결하면 `hello`(세션 행, 상태, pending, report)부터 오고, 이후 세션에서 일어나는 걸 다 받음.

받는 것:

| type | 내용 |
| --- | --- |
| `state` | `state`, `event`, `detail`, `tool`, `alive` (상태가 바뀔 때마다) |
| `message` | SDK 메시지 원본을 JSON으로 (`message.type`: `AssistantMessage`, `UserMessage`, `SystemMessage`, `ResultMessage`, `StreamEvent`(partial일 때), `TaskStartedMessage` …) |
| `turn` | 턴 하나가 끝남 (`prompt`, `texts`, `tools`, `complete`, `interrupted`, `result`) |
| `pending` / `pending_done` | 질문/권한이 생김 / 풀림 |
| `result` | 내가 보낸 명령의 결과 (`id`로 짝지음) |

보내는 것 (`id`는 내가 붙이는 요청 ID):

```json
{"type": "send", "id": "a1", "text": "...", "wait": true, "now": false, "force": false, "timeout_s": 120}
{"type": "interrupt", "id": "a2"}
{"type": "answer", "id": "a3", "pending_id": "q_1234abcd", "answers": {"질문": "답"}}
```

- 구독자 큐가 넘치면(느린 클라이언트) 그 구독자만 끊김. 세션 흐름은 안 막힘.
- 연결이 끊겨도 보낸 메시지는 세션에서 그대로 진행됨 (결과만 버림).
- `partial: true`면 `StreamEvent`의 `content_block_delta`/`text_delta`로 글자가 나오는 대로 받음 → TTS에 바로.

## 카디널 도구 (`mcp__cardinal__*`)

SDK 세션에는 서버 프로세스 안 MCP 서버 `cardinal`이 붙어 있음 (묻지 않고 허용). Bash로 `cardinal` CLI를 부를 필요 없음.

| 도구 | |
| --- | --- |
| `reply(event_id, text, files[])` | 채널 이벤트에 답장 (파일은 로컬 경로, 최대 10개·각 10MB, 상대 경로는 작업 폴더 기준) |
| `session_list()` | 세션 목록 |
| `session_new(name, prompt, role, cwd, backend, wait, timeout_s)` | 워커 만들기. cwd 기본은 이 세션 폴더, backend 기본 sdk. 부모(`parent_name`)가 기록됨 |
| `session_send(name, text, wait, timeout_s)` | 지시 보내기 (tmux 세션도 됨) |
| `session_report(name)` | 결과 보고 |
| `session_kill(name, purge)` | 정리 |

전달 메시지(`[cardinal:event …]`)의 답장 안내도 SDK 세션이면 `mcp__cardinal__reply`로 나감. 환경변수 `CARDINAL_SERVER_URL`, `PATH`에 `bin/`도 넣어둬서 Bash에서 `cardinal reply`도 쓸 수는 있음.

## 안에서 도는 방식

`server/cardinal_server/sdk.py`:

- `SdkSession` 하나 = `ClaudeSDKClient` 하나 + `receive_messages()`를 계속 읽는 태스크 하나.
  - 턴 시작: 매 query마다 오는 `SystemMessage(init)` 또는 `UserPromptSubmit` 훅 → 그 턴 `accepted`
  - 턴 끝: `ResultMessage`. `terminal_reason`이 `aborted_*`면 중단. `origin.kind == "task-notification"`이면 우리가 안 보낸 턴(agent)
  - 텍스트/도구: 메인 에이전트의 `AssistantMessage`만 (서브 에이전트 것은 `parent_tool_use_id`가 있어서 뺌)
  - 상태: busy(턴 중, `PreToolUse`면 도구 이름) / waiting(pending 있음) / idle / ended(프로세스 끝남·오류)
- 질문: `can_use_tool`로 옴 (auto 모드에서도 AskUserQuestion은 여기로 옴, 실측). `Pending`으로 들고 있다가 답이 오면 `PermissionResultAllow(updated_input={...input, "answers": ...})`.
- 훅: `PreToolUse`, `PostToolUse(Failure)`, `UserPromptSubmit`, `Stop`, `Subagent*`, `PreCompact`, `Notification`, `PermissionRequest` 콜백 → `session_events`.
- 시스템 프롬프트: Claude Code 기본(preset) + 카디널 역할 프롬프트 + `append_prompt`.
- 새 대화는 `session_id`를 미리 정해서 시작, restart는 `resume=<마지막 claude 세션 ID>`.
- `server/cardinal_server/sessions.py`(`Sessions`)가 백엔드를 골라서 부름. 라우터, API, 마스터 도구가 다 이걸 씀.
- DB: `sessions.backend`(`tmux`|`sdk`), `sessions.sdk_options`(JSON), `sdk_turns`. 수집기(ingest)는 tmux 세션만 다룸 (SDK 세션은 파일이 없어서 지워진 걸로 보면 안 됨).

## 확인한 것

scratch 서버(`--sdk`, haiku 모델)로 실제 돌려서:

- 생성 0.7초 → idle, send → "pong 7" 1.1초, report 모양이 tmux와 같음
- 질문: AskUserQuestion → pending(`waiting`) → `/ws/sdk`로 답 → "chose Mango". 질문 대기 중 보낸 다음 메시지는 그 턴이 끝난 뒤 따로 턴
- 동시에 3개 send → 각각 다른 턴, 각자 자기 답
- interrupt: Bash `sleep 30` 중에 → 즉시 `interrupted`, 다음 send 정상
- 채널: local 이벤트 → 전달 `sent` → 자동 답장 / 에이전트가 `mcp__cardinal__reply`로 텍스트+파일(note.txt) 답장. 자동 답장 중복 없음
- 마스터(SDK)가 `session_new`로 워커를 띄워 응답 회수, 워커 `parent=m1`, 같은 폴더
- restart(resume) 뒤 앞 대화 기억, 서버 재시작 뒤 `ended` → restart로 기억 유지, `resume_on_start` 세션은 서버 켜질 때 자동
- 외부 MCP(stdio) 연결 → 도구 호출 "zebra-15", disable/enable/reconnect, `strict_mcp_config`면 그 서버 + cardinal만
- claude 프로세스를 kill -9 → 즉시 `ended`(사유 포함), 보내기 거부, restart로 복구
- `partial` → `StreamEvent` 텍스트 조각 수신
- 같은 서버에서 tmux 세션도 정상, 이름 충돌·tmux 전용 API 거부, `--sdk` 없는 서버는 SDK 생성 거부

## 아직 안 한 것

- 웹 UI (SDK 세션 전용 화면: pending 답하기, MCP 상태, 스트림). 지금 UI에서도 목록·보내기·결과·라우트는 보이지만 터미널/화면 탭은 안 됨
- 디스코드 실제 봇으로는 미검증 (local 채널로 확인, 같은 라우터라 동작은 같음)
- 권한 모드를 auto가 아닌 걸로 오래 굴려본 것, 이미지 입력(스트리밍 입력 블록), 서브 에이전트 메시지 따로 보여주기
