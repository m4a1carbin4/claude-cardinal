# 관리자 세션

[English](admin-session.en.md) · 관련: [SDK 모드](sdk-mode.md), [카디널 MCP](mcp.md), [서버](server.md)

카디널 설치 전체를 맡는 **마스터 세션 하나**. SDK 모드 서버(`cardinal-server --sdk`)가 켜질 때마다 서버가 직접 띄우고, 매번 **같은 세션 ID, 같은 claude 대화**를 이어감. 사람은 이 세션에 말 걸어서 세션·라우트·채널을 관리시키면 됨.

## 어떻게 뜨나

- 이름은 `cardinal` (`CARDINAL_ADMIN`으로 바꿈, `CARDINAL_ADMIN=0`이면 끔). SDK 모드일 때만
- 처음 켤 때 세션 기록(행)을 만들고, 그 뒤로는 **그 행 하나를 계속 씀** → 카디널 세션 ID(`id`)도 claude 대화 ID(`claude_session_id`)도 안 바뀜
- 서버가 요청을 받기 시작하면 이어서 띄움 (`resume_on_start`와 같은 길, 카디널 MCP 에 붙어야 해서)
- 같은 이름의 SDK 세션이 이미 있으면 그걸 관리자로 바꿔서 이어감. tmux 세션이 그 이름을 쓰고 있으면 경고만 남기고 안 띄움
- 역할은 `master`, 작업 폴더는 카디널 저장소, `sdk_options`에 `admin: true`, `resume_on_start: true`
- 대화 파일(`~/.claude/projects/…/<ID>.jsonl`)이 없어졌으면 **같은 ID 로 새 대화**를 시작함 (ID 유지). 이어가기 자체가 실패하면(파일 손상 등) 새 ID 로라도 뜸 (서버가 켜져 있는 동안 관리자는 있어야 해서)

## 다른 세션과 다른 점

| | 관리자 | 보통 마스터 |
| --- | --- | --- |
| 카디널 MCP | `/mcp/admin` (마스터 도구 + 아래 관리 도구) | `/mcp/master` |
| 시스템 프롬프트 | 마스터 프롬프트 + 관리자 프롬프트 (저장소·데이터 위치, 지킬 것) | 마스터 프롬프트 |
| 읽을 수 있는 폴더 | 저장소 + 드라이브 + 카디널 데이터(`~/.cardinal`: DB, 로그) | 작업 폴더 + 드라이브 |
| 지우기 (`purge`) | 안 됨. 끄기(kill)만 되고, 서버를 다시 켜면 이어서 뜸 | 됨 |
| 새 대화로 다시 띄우기 (`resume=false`) | 안 됨 (같은 대화를 이어감) | 됨 |
| 다른 세션이 `session_kill` | 안 됨 (사람만 웹 UI/API 로) | 마스터가 할 수 있음 |
| 이름 | 예약됨. 다른 세션은 이 이름으로 못 만듦 | |

캐릭터로 말 걸기: [스테이지](stage.md) (`/stage`).

웹 UI 에는 `admin` 배지가 붙고, `GET /api/health`에 `admin: {name, state, alive}`가 나옴. 세션 행에는 `admin: true`.

## 관리 도구 (`/mcp/admin`에만)

| 도구 | 하는 일 |
| --- | --- |
| `session_restart` | 끝난 세션 다시 띄우기. SDK 는 `resume=true`(기본)면 대화 이어서, tmux 는 tmux 가 없어진 것만 같은 대화로 (`cardinal revive`) |
| `route_list` | 채널 라우트 목록 (`session`을 주면 그 세션 것만). 각 줄에 세션 이름 |
| `route_add` | 라우트 추가 (`session`, `platform`, `channel`, `trigger`, `match`, `auto_reply`, `allow_bots`) |
| `route_delete` | 라우트 지우기 (`route_id`) |
| `server_status` | 서버 주소, SDK 모드, 채널 연결 상태, 세션 수 |
| `event_list` | 최근 채널 이벤트와 전달·답장 결과 |

그 밖에 마스터 도구(세션 만들기·보내기·기다리기·보고·끄기, 화면·키, 질문 답하기)와 드라이브 도구는 그대로.

`/mcp/admin`은 부른 세션이 관리자인지(이름 + `admin` 옵션 + SDK + master) 확인해서 아니면 403.

## 오래 사는 세션이라

- 대화가 길어지면 Claude Code 가 앞부분을 요약함. 프롬프트에서 오래 기억할 것을 드라이브 `/sessions/cardinal/NOTES.md`에 적고 일 시작할 때 다시 읽으라고 시킴
- 서버 끄기·다시 띄우기(`launchctl`, `autostart.sh`), 카디널 소스 수정·커밋·푸시는 **사람이 시킬 때만** 하라고 프롬프트에 넣음 (서버를 끄면 자기도 꺼지고, 서버는 체크아웃된 코드로 돎)
- 다른 세션 끄기·라우트 지우기 전에는 사람이 시킨 일인지 확인하라고 함

## 파일

| 파일 | |
| --- | --- |
| `server/cardinal_server/sdk.py` | `ADMIN_PROMPT`, `SdkManager.ensure_admin`, 대화 파일 없을 때 같은 ID 로 시작, 지우기·새 대화 막기 |
| `server/cardinal_server/mcp_server.py` | `/mcp/admin`, 관리 도구, 관리자 `session_kill` 막기 |
| `server/cardinal_server/sessions.py` | 이름 예약, `restart` (sdk/tmux 공통) |
| `server/cardinal_server/config.py` | `CARDINAL_ADMIN` |
| `server/cardinal_server/app.py` | `/api/health`의 `admin`, 세션 행 `admin` |

## 확인한 것

임시 홈·포트 7889 서버로:

- 처음 켤 때 `cardinal` 행을 만들고 자동으로 뜸 (`idle`), health 에 `admin` 나옴
- `purge`, 같은 이름으로 만들기, `resume=false` 다시 띄우기 → 전부 400 과 이유
- 관리자에게 `server_status`·`route_list`·`session_list`를 부르게 함 → 잘 됨 (`session_list`에 `admin: true`)
- 서버 껐다 켜기 → 행 ID·claude 대화 ID 그대로, 바로 전 대화를 기억함
- 보통 마스터 세션 키로 `/mcp/master` 200, `/mcp/admin` 403. 관리자 키로 `tools/list` 하면 관리 도구 6개가 더 있음
- 대화 파일을 치우고 서버 다시 켜기 → "같은 ID 로 새 대화" 경고 후 같은 claude 대화 ID 로 뜨고 대답함
