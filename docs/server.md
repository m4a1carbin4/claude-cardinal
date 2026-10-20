# 카디널 서버 (Python / FastAPI)

[English](server.en.md) · 관련: [세션 시스템](session-system.md), [웹 터미널](web-terminal.md)

CLI 안에 있던 서버(`cardinal serve`)를 `server/`의 Python 서비스로 분리함. 메시지 채널이랑 DB를 붙이려고.
이 문서는 "요청 하나가 들어와서 어디를 어떤 순서로 지나가는지"를 코드 위치랑 실제 기록으로 따라감.

목차

1. [전체 구조](#1-전체-구조)
2. [실행과 설정](#2-실행과-설정)
3. [서버 기동 순서](#3-서버-기동-순서)
4. [흐름 A: 세션 생성 (라우트 포함)](#4-흐름-a-세션-생성-라우트-포함)
5. [흐름 B: 파일 → DB 수집](#5-흐름-b-파일--db-수집)
6. [흐름 C: 채널 메시지 수신 → 세션 전달](#6-흐름-c-채널-메시지-수신--세션-전달)
7. [흐름 D: 에이전트 답장 (`cardinal reply`)](#7-흐름-d-에이전트-답장-cardinal-reply)
8. [흐름 E: 자동 답장 (`auto_reply`)](#8-흐름-e-자동-답장-auto_reply)
9. [흐름 F: 웹 터미널 / 상태 푸시](#9-흐름-f-웹-터미널--상태-푸시)
10. [실제 기록으로 보는 타임라인](#10-실제-기록으로-보는-타임라인)
11. [DB 스키마](#11-db-스키마)
12. [실패/예외 상황](#12-실패예외-상황)
13. [REST / 웹소켓 목록](#13-rest--웹소켓-목록)
14. [디스코드 봇 설정](#14-디스코드-봇-설정)
15. [테스트한 것 / 아직 안 된 것](#15-테스트한-것--아직-안-된-것)

---

## 1. 전체 구조

```
            디스코드                                   브라우저 / 외부 시스템
               │ (게이트웨이 웹소켓, 항상 연결)              │ HTTP / WS
               ▼                                             ▼
 ┌──────────────────────────────── cardinal-server (FastAPI, 프로세스 1개) ─────────────────────────────┐
 │                                                                                                       │
 │  channel/discord_adapter ─┐                                                                           │
 │  channel/local_adapter ───┴─▶ router.handle ──▶ 라우트 매칭 ──▶ router._deliver ──▶ cli.send ─────────┼──▶ cardinal CLI
 │                                    │                                                                  │
 │                                    └─▶ DB: channel_events / deliveries                                │
 │                                                                                                       │
 │  POST /api/events/<id>/reply ──▶ router.reply ──▶ adapter.send_reply ──▶ DB: replies                  │◀── cardinal reply
 │                                                                                                       │    (세션 안 에이전트)
 │  ingest.Ingestor ── ~/.cardinal/sessions 감시 ──▶ DB: sessions / session_events ──▶ /ws/events 푸시   │◀── 훅이 파일에 씀
 │                                                                                                       │
 │  terminal.bridge ── /ws/term/<이름> ── pty 안의 `tmux attach`                                          │
 │  REST /api/sessions/... ──▶ cli.* (new/kill/send/keys/screen/report)                                  │──▶ cardinal CLI
 └───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

원칙 세 가지:

- **세션 제어 로직은 CLI 한 곳.** 서버는 `cardinal ... --json`을 subprocess로 부르기만 함 (`server/cardinal_server/cli.py`). tmux 조작, 훅 주입, 트랜스크립트 파싱은 전부 TS 쪽. 서버 없이도 CLI는 그대로 다 됨.
- **기록은 파일이 원본, DB는 모음집.** CLI는 `~/.cardinal/sessions/<이름>/meta.json`, 훅은 자기 전용 폴더 `~/.cardinal/hooks/<instanceId>/`에만 씀. 서버는 읽기만 해서 SQLite에 모음. 서버가 꺼져 있어도 기록은 안 날아가고, 켜지면 따라잡음.
- **채널 쪽 기록은 DB가 원본.** 채널 이벤트/전달/답장은 서버만 아는 정보라 DB에 바로 씀.

---

## 2. 실행과 설정

```sh
cd server
uv sync
uv run cardinal-server                     # http://127.0.0.1:7878
DISCORD_TOKEN=xxx uv run cardinal-server   # 디스코드 채널 켜기
```

| 환경변수 | 기본값 | |
| --- | --- | --- |
| `CARDINAL_HOME` | `~/.cardinal` | CLI랑 공유. 서버가 CLI 부를 때도 그대로 넘김 |
| `CARDINAL_WORKSPACE` | `~/.cardinal/workspace` | 세션 작업 폴더 (CLI가 씀) |
| `CARDINAL_DB` | `$CARDINAL_HOME/cardinal.db` | |
| `CARDINAL_HOST` / `CARDINAL_PORT` | `127.0.0.1` / `7878` | `--host`, `--port`로도 |
| `CARDINAL_TOKEN` | 없음 | 있으면 HTTP/WS 전부 `?token=` 또는 `Authorization: Bearer` |
| `CARDINAL_CLI` | `<repo>/bin/cardinal` | |
| `DISCORD_TOKEN` | 없음 | 없으면 디스코드 끄고 local 채널만. 잘못된 토큰이면 에러 로그(`디스코드 연결 실패 …`)를 남기고 디스코드만 꺼짐. `GET /api/health`로 확인 |

설정은 `config.py`의 `load()`가 한 번 읽어서 `Settings`(frozen dataclass)로 들고 다님.

---

## 3. 서버 기동 순서

`app.py`의 `create_app()`이 객체를 만들고, `lifespan()`(`app.py:147`)이 켜고 끔.

```
create_app()
 ├─ DB(settings.db_path)        ← 파일 없으면 만들고 스키마 적용 (CREATE TABLE IF NOT EXISTS), WAL 모드
 ├─ Cli(settings)               ← CARDINAL_HOME 박은 env 준비
 ├─ Hub() × 2                   ← /ws/events 구독자, /ws/channel 구독자
 ├─ Ingestor(on_change=sessions_changed)
 ├─ Router(publish=channel_hub.publish)
 └─ LocalAdapter → router.add_adapter

lifespan 시작
 1. await ingestor.sync()                  첫 동기화. 서버 꺼져 있던 동안 쌓인 훅 이벤트 전부 따라잡기
 2. ingestor.run() 백그라운드 태스크         파일 감시 루프
 3. local.start(router.handle)
 4. DISCORD_TOKEN 있으면 DiscordAdapter 만들고 start → client.start(token) 태스크 (게이트웨이 접속)
 5. ~/.cardinal/server.json 쓰기 {url, token, pid}, 권한 600
    → 세션 안의 `cardinal reply`가 이걸 읽고 서버를 찾음
 ── 서비스 중 ──
lifespan 종료
 6. server.json의 pid가 자기면 삭제 (다른 서버가 덮어썼으면 안 지움)
 7. ingest 태스크 취소, 디스코드 연결 닫기
```

1번을 `run()` 전에 따로 await 하는 이유: 첫 요청이 들어오기 전에 DB가 최신이어야 라우트 매칭이 맞게 돌아감.

---

## 4. 흐름 A: 세션 생성 (라우트 포함)

요청:

```http
POST /api/sessions
{"name":"helper","routes":[{"platform":"local","channel":"dev","trigger":"!ask","match":"prefix"}]}
```

```
클라이언트          app.create_session (app.py:231)       cardinal CLI (TS)                  tmux / claude
    │ POST ───────────▶│
    │                  │ pydantic SessionIn 검증
    │                  │  (role ∈ worker|master, match ∈ prefix|contains|regex|mention …)
    │                  │ cli.new() ── subprocess ──────────▶│ `cardinal new helper --role worker --json`
    │                  │                                    │  이름 검사, UUID 발급, meta/state(starting) 파일 쓰기
    │                  │                                    │  tmux new-session … claude --session-id … --settings <훅>
    │                  │                                    │────────────────────────────────▶│ claude 기동
    │                  │◀──── stdout JSON (getStatus) ───────│
    │                  │ await ingestor.sync()   ← 방금 만든 세션을 DB에 바로 반영
    │                  │ db.add_route(sid, …)    ← 라우트는 세션 고유 키(instanceId)에 붙음
    │◀─ 201 {세션 + routes} │
```

단계별:

1. **검증** (`app.py:93` `SessionIn`, `:54` `RouteIn`): 모르는 `match` 값이나 `role`은 여기서 422로 튕김.
2. **CLI 호출** (`cli.py:47` `Cli.new`): `cardinal new <이름> --role <role> [--prompt …] --json [-- claude 인자]`.
   - `asyncio.create_subprocess_exec`로 부름 (셸 안 거침). 종료 코드가 0이 아니면 stderr의 `cardinal: …` 메시지를 `CliError`로 → HTTP 400.
   - CLI 쪽 동작은 [세션 시스템](session-system.md#세션-만들기) 그대로: 고정 작업 폴더, `--session-id` 미리 지정, 훅 `--settings` 주입, 역할 프롬프트 (외부 이벤트면 `cardinal reply`로 답하라는 안내 포함).
3. **즉시 동기화** (`ingestor.sync()`): 파일 감시가 알아채길 기다리지 않고 바로 DB에 넣음. 응답에 DB 행을 담아 주려고.
4. **라우트 저장** (`db.py:234` `add_route`): `routes.session_id` = 세션 고유 키(instanceId). 이름이 아니라 고유 키에 붙이니까, 같은 이름으로 세션을 새로 만들면 예전 라우트는 따라오지 않음.
5. **응답**: `sessions` 행 + `routes` 배열. 이 시점 state는 보통 `starting` (claude가 아직 `SessionStart` 훅을 안 찍음).

실제 응답 (테스트 때):

```json
{"name":"helper","state":"starting","alive":true,"routes":[{"id":1,"channel":"dev","trigger":"!ask","match":"prefix"}]}
```

그 뒤 약 4초 후 claude가 `SessionStart` 훅을 찍으면 → state.json이 `idle` → 흐름 B로 DB도 `idle`.

---

## 5. 흐름 B: 파일 → DB 수집

`ingest.py`. 훅은 파일에만 쓰고 서버랑 직접 통신 안 함. 그래서 서버가 꺼져 있어도 훅이 실패하지 않음.

```
claude 훅 (dist/hook.js <훅 폴더>)           ~/.cardinal/hooks/<instanceId>/          Ingestor.run (ingest.py:111)
   │ state.json 덮어쓰기 (tmp → rename) ──────▶│ state.json                          │
   │ events.jsonl 한 줄 추가 ─────────────────▶│ events.jsonl                         │
                                              │── watchfiles 변경 알림 (150ms 디바운스) ─▶│ _kick.set()
                                              │   (sessions/ 와 hooks/ 둘 다 감시)        │
                                                                                     │ sync()
                                                                                     │  ├ tmux list-sessions (살아있는 세션 이름 집합)
                                                                                     │  ├ sessions/*/meta.json 마다 → 그 instanceId 의 훅 폴더 state.json → upsert_session
                                                                                     │  ├ 훅 폴더 events.jsonl 오프셋부터 읽기 → session_events INSERT
                                                                                     │  ├ 폴더 없어진 세션 → mark_deleted
                                                                                     │  └ 세션 목록 스냅샷이 바뀌었으면 on_change()
                                                                                     │       → /ws/events 로 {"type":"sessions",…} 푸시
                                                                                     │ 변화 없어도 3초마다 한 번 더 (tmux가 밖에서 죽는 경우)
```

`sync()` (`ingest.py:82`) 자세히:

1. **tmux 생존 확인** (`_tmux_sessions`): `tmux list-sessions -F '#{session_name}'` 한 번. tmux 서버 자체가 없으면 실패 → 빈 집합.
2. **세션 upsert** (`db.py:149`): 키는 `meta.instanceId` (예전 세션은 `meta.claudeSessionId`). 훅 폴더는 meta가 가리키는 것만 읽음. 지금 claude 세션 ID(`state.json`의 `claudeSessionId`, `/clear` 하면 바뀜)는 `claude_session_id` 칼럼으로.
   - tmux에 없으면 state.json 내용과 상관없이 `state='ended'`, `alive=0`.
   - `ON CONFLICT DO UPDATE`로 상태 칼럼들만 갱신, `deleted_at=NULL`로 되돌림.
3. **이벤트 따라잡기** (`_tail_events`, `ingest.py:53`):
   - `ingest_offsets`에서 이 세션을 어디까지 읽었는지(바이트) 가져옴.
   - 파일 크기가 더 크면 그 뒤만 읽음. **마지막 `\n`까지만** 처리 (훅이 쓰는 중인 반쪽 줄은 다음 차례).
   - 줄마다 JSON 파싱해서 `session_events`에 넣고, 새 오프셋까지 **한 트랜잭션**으로 커밋 (`db.py:210`). 중간에 죽어도 중복/누락 없음.
4. **삭제 감지**: DB에선 살아있는데 폴더가 없는 세션 → `deleted_at` 찍음. `kill --purge`하거나 같은 이름으로 새로 만들 때 (CLI가 예전 폴더를 지우고 새로 씀) 생김. 행 자체는 안 지움.
5. **변경 알림**: `sessions` 전체를 JSON으로 만들어 직전 것과 비교, 다르면 `on_change()` → `/ws/events` 푸시.

`sync()`는 `asyncio.Lock`으로 한 번에 하나만 돔 (API의 즉시 동기화와 감시 루프가 겹칠 수 있어서).

실제 오프셋 (테스트 후): `helper` 3668바이트, `auto` 733바이트까지 읽음.

---

## 6. 흐름 C: 채널 메시지 수신 → 세션 전달

### 6-1. 메시지 들어오는 입구

| 입구 | 코드 | 만드는 것 |
| --- | --- | --- |
| 디스코드 메시지 | `discord_adapter.py:41` `on_message` | `InboundMessage(platform="discord", …)` |
| `POST /api/channel/inbound` | `app.py:312` | `InboundMessage(platform="local", …)` |
| `/ws/channel`에 `{"type":"message",…}` | `app.py:380` | `InboundMessage(platform="local", …)`, 첨부는 base64 |

디스코드 어댑터가 채우는 값:

| 필드 | 값 |
| --- | --- |
| `channel_id` | `str(message.channel.id)` |
| `channel_name` | 채널 이름. DM이면 `"dm"`, 스레드면 스레드 이름 |
| `guild` | 서버 이름 (DM이면 없음) |
| `message_id` | 답장할 때 원래 메시지 찾는 용도 |
| `author` | `str(message.author)` |
| `mentions_bot` | 봇이 멘션됐는지 |
| `attachments` | 파일명/크기/타입/URL + `read` (내용은 필요할 때만 다운로드) |

**봇 메시지는 전부 무시** (자기 자신 포함). 안 그러면 자기 답장에 트리거가 들어 있을 때 무한 루프.

### 6-2. `router.handle` (`router.py:129`)

```
InboundMessage
 1. evt_<8자리 hex> ID 발급, channel_events INSERT (첨부는 아직 빈 배열)
 2. db.active_routes()  ← 살아있고(alive=1) 안 지워진 세션의 켜진 라우트 + 세션 이름/상태 JOIN
 3. 라우트마다 match_route(route, msg)
 4. 하나라도 맞고 첨부가 있으면 → 첨부 다운로드 → ~/.cardinal/inbox/<evt>/파일명 → channel_events.attachments 갱신
 5. 맞은 라우트마다 (세션당 1번만) _deliver 를 백그라운드 태스크로
 6. /ws/channel 에 {"type":"event", event, matched:[세션이름…]} 푸시
 7. 반환 (HTTP로 들어온 경우 응답 바디)
```

- **아무 라우트에도 안 맞아도 이벤트는 저장됨.** 나중에 "뭐가 들어왔었는지" 볼 수 있게.
- **첨부는 맞은 게 있을 때만 받음.** 아무도 안 받을 파일까지 받을 필요 없어서.
- **전달은 기다리지 않음.** `_deliver`를 태스크로 던지고 바로 리턴. `auto_reply`는 몇 분 걸릴 수 있어서, 기다리면 디스코드 이벤트 루프가 막힘.

### 6-3. 라우트 매칭 (`router.py:32` `match_route`)

순서대로 검사, 하나라도 안 맞으면 탈락:

1. `platform`: `*`이거나 메시지 플랫폼이랑 같아야 함.
2. `channel`: 비어 있으면 통과. 있으면 앞의 `#` 떼고 `channel_name` 또는 `channel_id`랑 같아야 함.
3. `match`별:

| match | 조건 | 세션에 넘기는 본문 |
| --- | --- | --- |
| `mention` | 봇이 멘션됨 (trigger 무시) | `<@123…>` 멘션 태그 지운 본문 |
| (trigger 비어 있음) | 무조건 | 원문 |
| `prefix` | `content.startswith(trigger)` | 트리거 뗀 나머지 (`!ask 안녕` → `안녕`) |
| `contains` | `trigger in content` | 원문 |
| `regex` | `re.search(trigger, content)` | 원문. 정규식이 깨졌으면 경고 로그 + 불일치 |

대소문자는 구분함.

### 6-4. 첨부 저장 (`router.py:108`)

- 크기가 25MB 넘으면 안 받고 `error` 표시.
- 디스코드는 `attachment.read()`로 받고, local은 이미 들어온 바이트 사용.
- 파일명은 `[^\w.\-]` → `_`로 바꿔서 경로 탈출 방지.
- 하나 실패해도 이벤트 전달은 계속. 실패한 건 세션 메시지에 `저장 실패: …`로 표시.

### 6-5. 세션 전달 (`router.py:161` `_deliver`)

1. **상태 확인**: 세션 state가 `idle`/`busy`/`starting`이면 전달 시작. `waiting`(승인 대기)이면 전달 안 하고 `deliveries`에 `failed` (`세션 상태 waiting`).
   - `busy`/`starting`: CLI가 idle 될 때까지 기다렸다가 보냄 (작업 중에 넣으면 진행 중인 턴에 끼어들고, 다이얼로그에 넣으면 텍스트가 다이얼로그로 감). 막 만든 세션에 바로 온 이벤트도 이렇게 기다렸다 들어감. 예전엔 `starting`이면 바로 실패였음.
   - 신뢰 다이얼로그에 걸려서 idle이 안 되면 600초 뒤 `failed`.
2. **메시지 만들기** (`format_delivery`, `router.py:64`). 실제로 세션에 들어간 텍스트:

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

   외부에서 온 값(본문, 작성자, 채널/서버 이름, 첨부 경로)은 탭·줄바꿈 빼고 **제어 문자를 지움** (`clean`). tmux는 붙여넣기 내용을 안 걸러서 `ESC[201~` 같은 게 그대로 감. 실제 claude에선 Claude Code가 걸러줘서 탈출은 재현 안 됐지만 방어용.

   첫 줄의 `[cardinal:event <ID>]`가 약속된 표시. 세션 시스템 프롬프트에 "이걸로 시작하면 외부 이벤트고, 답은 `cardinal reply`로만 전달된다"가 들어 있음.
3. **`pending` 기록**: `deliveries`에 `pending` 행을 먼저 넣고 `/ws/channel`에 `{"type":"delivery", …, "status":"pending"}` 푸시.
4. **세션 락** (서버 안): 세션마다 `asyncio.Lock` 하나. 같은 세션에 가는 전달은 하나씩. `auto_reply`면 답장까지 끝나야 다음 이벤트로 넘어감.
5. **보내기** (`cli.py:56` `Cli.send`): `cardinal send <이름> - --queue-timeout 600 --json`, 텍스트는 **stdin으로** 넘김 (인자로 넘기면 `-`로 시작하는 본문을 옵션으로 오해함).
   - CLI 안에서 ([세션 시스템 send](session-system.md#send)): 세션 파일 락 → `busy`면 idle 대기 → `waiting`이면 거부 → 붙여넣기 → 200ms → `Enter` → 훅 상태가 바뀌는지(받았는지) 확인 (`src/session.ts:288-327`).
   - 서버 쪽 subprocess 타임아웃은 idle 대기를 감안해서 `600 + 30`초.
6. **결과 기록**: claude가 받았으면(`accepted`) `sent`, 못 받았거나 CLI 에러면 `failed` + 사유로 같은 행을 갱신.
7. `/ws/channel`에 `{"type":"delivery", event_id, session, status}` 푸시.

락이 두 겹인 이유: CLI 파일 락은 프로세스가 달라도 (서버, 마스터, 사람) 막아주고, 서버 락은 서버 안에서 이벤트 순서를 지키고 `auto_reply` 한 사이클을 통째로 묶음.

claude 입장에서 이 텍스트는 **붙여넣기(paste)로 들어온 입력**임. 실제로 `UserPromptSubmit` 훅에 찍힌 프롬프트를 보면 Claude Code가 `<pasted_content …>` 태그로 감싸 놓음. 그래서 에이전트는 "사용자가 붙여넣은 내용"으로 봄. 지금은 시스템 프롬프트 안내 덕분에 잘 따르지만, 붙여넣은 내용 속 지시를 덜 믿는 모델 성향 때문에 나중에 문제가 될 수도 있음 ([12](#12-실패예외-상황) 참고).

---

## 7. 흐름 D: 에이전트 답장 (`cardinal reply`)

```
세션 안 claude (Bash 도구)          cardinal CLI (src/reply.ts)                 서버                                  디스코드
   │ cardinal reply evt_… "…" --file a.png
   │────────────────────────────▶│ 1. 텍스트/파일 검사
   │                             │ 2. 서버 주소 찾기
   │                             │ 3. multipart POST /api/events/evt_…/reply ──▶│ app.reply (app.py:319)
   │                             │                                             │  UploadFile → OutboundFile
   │                             │                                             │ router.reply (router.py:199)
   │                             │                                             │  이벤트 조회 → 어댑터 고르기
   │                             │                                             │  adapter.send_reply ─────────────▶│ 원래 메시지에 답장
   │                             │                                             │  replies INSERT (sent/failed)
   │                             │                                             │  /ws/channel {"type":"reply_saved"}
   │                             │◀──────── 200 {replies 행} / 4xx·5xx {detail} ─│
   │◀── "sent reply to evt_…" / 에러 + exit 1
```

CLI 쪽 (`src/reply.ts`):

1. **검사** (`checkFiles`, `:27`): 텍스트나 파일 중 하나는 있어야 함. 파일마다 존재·일반 파일 여부 확인, 최대 10개, 각 10MB (디스코드 무부스트 서버 한도). 여기서 걸리면 서버까지 안 감.
2. **서버 찾기** (`serverInfo`, `:17`): `CARDINAL_SERVER_URL` 환경변수 → 없으면 `~/.cardinal/server.json`. 토큰은 `CARDINAL_TOKEN` → 없으면 server.json의 토큰. 파일도 없으면 "서버가 안 떠 있음?" 에러.
3. **전송**: `FormData`에 `text`, `session`(`CARDINAL_SESSION` 환경변수 = 세션 이름), `files`(여러 개). `Authorization: Bearer <토큰>`.

서버 쪽:

4. **엔드포인트** (`app.py:319`): 폼 필드를 받아 `UploadFile`을 바이트로 읽어 `OutboundFile(filename, data, content_type)`로. 서버에서도 한 번 더 검사: 텍스트·파일 둘 다 없으면 400, 파일 11개 이상이나 10MB 초과면 413 (CLI를 안 거치고 API를 직접 불러도 막히게).
5. **`router.reply`** (`router.py:199`):
   - `channel_events`에서 이벤트 조회. 없으면 `LookupError` → **404**.
   - 이벤트의 `platform`으로 어댑터 선택. 그 플랫폼이 연결 안 돼 있으면 (예: 디스코드 이벤트인데 토큰 없이 재시작) 실패.
   - `session` 이름으로 세션 ID 찾아서 기록에 붙임 (못 찾아도 답장은 보냄).
   - `adapter.send_reply` 호출 → 성공이면 `status='sent'` + 보낸 메시지 ID들, 예외면 `status='failed'` + 에러.
   - **성공이든 실패든 `replies`에 기록**하고 `/ws/channel`에 `reply_saved` 푸시. 실패면 **502**로 응답.
6. **디스코드 발신** (`discord_adapter.py:89`):
   - 채널: 캐시(`get_channel`) → 없으면 API(`fetch_channel`).
   - 텍스트를 2000자 단위로 **줄 경계 기준** 분할 (`split_text`, `base.py:53`). 한 줄이 2000자보다 길면 그 줄만 강제로 자름.
   - 파일을 10개씩 묶음.
   - 메시지 수 = max(텍스트 조각 수, 파일 묶음 수). 첫 메시지는 원래 메시지에 **답장**(`reply`, 멘션 알림 없음), 나머지는 같은 채널에 이어서 `send`.
7. **local 발신** (`local_adapter.py:25`): `/ws/channel`에 `{"type":"reply", event_id, channel, text, files:[{filename, content_type, data(base64)}]}` 푸시.

실제 기록: 에이전트가 실행한 명령 (훅 `PreToolUse`의 `toolInput`)

```
'/Users/guest1/orca/claude-cardinal/bin/cardinal' reply evt_71363e3e "note.txt 에 적힌 숫자는 12 와 30 이고, 더하면 **42** 입니다."
```

---

## 8. 흐름 E: 자동 답장 (`auto_reply`)

라우트에 `auto_reply: true`가 있으면 `_deliver`가 다르게 돎 (`router.py:173`):

```
_deliver (세션 락 잡은 채로)
 1. deliveries 에 'pending'
 2. cli.send(name, text, wait=True, timeout_s=900)
      = cardinal send <이름> - --queue-timeout 600 --wait --timeout 900 --json
        CLI: 세션 락 → idle 대기 → 붙여넣기 + Enter → 받았는지 확인 → 락 풂
             → 보낸 시각(sentAt) 이후에 찍힌 상태만 인정하면서 idle/waiting/ended 될 때까지 0.5초마다 확인
             → Stop 뒤 트랜스크립트에 그 턴이 end_turn 으로 기록될 때까지 최대 5초 더 (마지막 답 줄이 Stop 보다 늦게 써져서)
        → {"sentAt", "accepted", "timedOut", "status", "last": 이 메시지가 만든 턴의 응답 텍스트 전체}
 3. accepted 면 delivery 'sent', 아니면 'failed'
    timedOut 이면 'sent' + "턴이 900초 안에 안 끝나서 자동 답장 안 함" (전달은 된 거라 실패로 안 침)
 4. sent 이고, timedOut 아니고, last 가 있고, **누가 됐든** 이 이벤트에 나간 답장(replies.status='sent')이 없으면
      → router.reply(…, source="auto")   ← 흐름 D의 5~7단계와 같음
 5. 세션 락 풂 → 다음 이벤트
```

- `last`는 같은 트랜스크립트 파서로 **이 메시지가 만든 턴**을 골라 그 assistant 텍스트 블록 전부. 끝난 직후 다음 이벤트가 새 턴을 시작해도 남의 답을 안 가져감.
- 이벤트를 받은 세션이든 다른 세션(마스터 등)이든 이미 `cardinal reply`로 답했으면 자동 답장은 건너뜀 → 중복 답장 없음. (예전엔 같은 세션이 답했는지만 봐서, 다른 세션이 답하면 한 번 더 나갔음)
- 턴이 `waiting`(승인 대기)으로 멈추면 그때까지의 부분 응답이 나감.
- 서버가 이 대기 중에 재시작되면 태스크가 사라져서 자동 답장은 안 됨.

실제 기록 (`auto` 세션, `contains "auto"`):

| 시각 | 무슨 일 |
| --- | --- |
| 08:55:51.091 | 이벤트 `evt_59ec53c3` 수신, delivery 기록 (이 테스트는 직렬화 전 버전이라 바로 `sent`. 지금은 `pending` → 턴 끝나고 `sent`) |
| 08:55:51.431 | `UserPromptSubmit` (붙여넣기 + Enter 끝) |
| 08:55:55.499 | `Stop` |
| 08:55:55.998 | 자동 답장 `21` 저장 (`source=auto`) — Stop 후 약 0.5초 (CLI 폴링 주기) |

---

## 9. 흐름 F: 웹 터미널 / 상태 푸시

### 웹 터미널 `/ws/term/<이름>` (`app.py:343` → `terminal.py:17`)

1. 토큰 검사 → DB에서 이름으로 세션 찾기. 없거나 `alive=0`이면 `4404`로 닫음.
2. `ptyprocess`로 pty를 만들고 그 안에서 `tmux attach-session -t =<tmux이름>` (관전 모드면 `-r -f ignore-size`).
3. `loop.add_reader(pty fd)` → 읽을 게 생기면 `os.read` → 큐 → `ws.send_bytes` (바이트 그대로).
4. 들어오는 텍스트 JSON: `{"t":"i","d":…}` → `os.write(pty fd)`, `{"t":"r","c","r"}` → `setwinsize`.
5. 어느 한쪽이 끝나면 (브라우저 닫힘 / tmux 끊김) 나머지 취소, pty의 tmux 클라이언트 종료 = detach. 세션은 그대로.

원리(pty 두 개, xterm.js, 제어 코드)는 [web-terminal.md](web-terminal.md).

### 상태 푸시

| 웹소켓 | 접속 직후 | 이후 |
| --- | --- | --- |
| `/ws/events` | `{"type":"sessions","sessions":[…]}` 한 번 | 세션 목록이 바뀔 때마다 같은 형식 (흐름 B 5단계) |
| `/ws/channel` | 없음 | `event` (수신 + 매칭 결과), `delivery`, `reply` (local 답장 본문), `reply_saved` (모든 답장 기록) |

`Hub.publish`는 구독자들에게 **동시에** 보내고, 구독자 하나당 2초 안에 못 보내면 그 구독자를 끊음. 느린 클라이언트 하나가 다른 구독자나 publish를 기다리는 라우터를 붙잡지 않게. (예전엔 순서대로 기다려서 하나가 느리면 전부 밀렸음)

`/ws/events`는 세션 목록이 실제로 바뀔 때만 푸시함. 비교할 때 매번 바뀌는 `updated_at`은 뺌 (예전엔 변화 없이도 3초마다 푸시됐음).

### 인증

- HTTP: 모든 라우트에 `Depends(auth)` (`app.py:188`). `?token=` 또는 `Authorization: Bearer`. 틀리면 401.
- WS: `ws_auth` (`app.py:192`)가 accept 전에 검사, 틀리면 `4401`로 닫음.
- `CARDINAL_TOKEN`이 없으면 전부 통과 (기본 바인딩이 127.0.0.1이라).
- uvicorn 로그(`uvicorn.access`, `uvicorn.error`)에 찍히는 `?token=xxx`는 `token=***`로 가림 (`_RedactToken` 필터, 서버 기동 때 붙임). 웹 페이지가 쿼리로 토큰을 써서 그대로 두면 로그에 남았음.

---

## 10. 실제 기록으로 보는 타임라인

local 채널 테스트 때 DB에 남은 그대로. 이벤트 `evt_71363e3e` (첨부파일 있는 `!ask`):

| 시각 (UTC) | 출처 | 기록 |
| --- | --- | --- |
| 08:55:09.094 | sessions | `helper` 생성 (API) |
| 08:55:13.271 | session_events #1 | `SessionStart` → idle |
| 08:55:20.146 | channel_events | `evt_76f03dd0` "그냥 잡담" → 매칭 0, 전달 없음 |
| 08:55:20.301 | channel_events | `evt_71363e3e` 수신, 라우트 1 매칭, `note.txt`(9바이트) inbox 저장 |
| 08:55:20.580 | deliveries | `helper` `sent` (수신 후 약 0.28초, 그중 0.2초는 Enter 전 대기) |
| 08:55:20.639 | session_events #2 | `UserPromptSubmit` → busy |
| 08:55:26.355 | session_events #3 | `PreToolUse Bash` `cat …/inbox/evt_71363e3e/note.txt` |
| 08:55:28.661 | session_events #4 | `PostToolUse Bash` |
| 08:55:31.322 | session_events #5 | `PreToolUse Bash` `cardinal reply evt_71363e3e "…42…"` |
| 08:55:32.547 | replies | `tool` `sent` "note.txt 에 적힌 숫자는 12 와 30 이고, 더하면 **42** 입니다." |
| 08:55:32.595 | session_events #6 | `PostToolUse Bash` (reply 명령 끝) |
| 08:55:34.830 | session_events #7 | `Stop` → idle |

눈여겨볼 점:

- 답장(`32.547`)은 에이전트 턴 도중에 나감. 턴 끝(`Stop`, `34.830`)을 기다리지 않음. `auto_reply`와 다른 점.
- 수신 → 에이전트가 첫 도구를 쓰기까지 약 6초는 모델 생각 시간.

---

## 11. DB 스키마

전체는 `db.py:SCHEMA`. 칼럼 의미:

### sessions

| 칼럼 | |
| --- | --- |
| `id` | 세션 고유 키 = instanceId (PK). 예전 세션은 처음 claude 세션 ID |
| `claude_session_id` | 지금 claude 세션 ID (`/clear` 하면 바뀜) |
| `name`, `role`, `tmux`, `cwd`, `claude_args`, `created_at` | meta.json에서 |
| `alive` | tmux에 세션이 있는지 (sync 때마다 갱신) |
| `state`, `state_at`, `last_event`, `detail`, `tool`, `transcript_path` | state.json에서. tmux 없으면 state는 `ended` |
| `deleted_at` | 기록 폴더가 사라진 시각 |
| `updated_at` | 마지막 upsert |

"이름으로 찾기"(`session_by_name`)는 `deleted_at IS NULL` 중 `created_at` 최신 1개.

### session_events / ingest_offsets

- `session_events`: `(session_id, at, event, tool, data)`. `data`는 events.jsonl 원본 줄 (프롬프트 2000자, 도구 입력 300자, `promptId` 등).
- `ingest_offsets`: `(session_id, offset)` 바이트 단위.

### routes

`(id, session_id, platform, channel, trigger, match, auto_reply, enabled, created_at)`. 테스트 때 실제 행:

| id | session | platform | channel | trigger | match | auto_reply |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | helper | local | dev | `!ask` | prefix | 0 |
| 2 | auto | local | dev | `auto` | contains | 1 |

### channel_events / deliveries / replies

- `channel_events`: `(id evt_…, platform, channel_id, channel_name, guild, message_id, author, content, attachments JSON, received_at)`. `attachments` 원소: `{filename, size, content_type, url, local_path | error}`.
- `deliveries`: `(event_id, session_id, route_id, status pending|sent|failed, error, delivered_at)`. `delivered_at`은 마지막으로 상태가 바뀐 시각.
- `replies`: `(event_id, session_id, source tool|auto, text, files JSON, status, error, external_ids JSON, created_at)`.

`GET /api/events`는 `channel_events` 최신순에 `deliveries`(세션 이름 JOIN), `replies`를 붙여서 줌.

---

## 12. 실패/예외 상황

| 상황 | 어디서 | 결과 |
| --- | --- | --- |
| CLI가 에러 (이름 중복, 모르는 세션 등) | `cli.py:run` | `CliError` → API 400, 메시지는 CLI stderr 그대로 |
| CLI가 안 끝남 | `cli.py:run` | 기본 60초, `send`는 idle 대기 600초 + `--wait` 타임아웃 + 30초 뒤 kill → `CliError("… 시간 초과")` |
| `/send`에 `wait`만 주고 `timeout_s` 없음 | `app.py` `send` | 기본 900초만 기다림 (예전엔 세션이 멈추면 요청이 안 끝났음) |
| `--wait` 시간 초과 | CLI `send` | 실패가 아님: `timedOut: true` + 부분 응답. 전달 기록은 `sent` (예전엔 `failed`) |
| 막 뜬 세션에서 Enter가 먹힘 | CLI `send` | `SessionStart` 후 1.5초 대기 + Enter 최대 3번. 그래도 안 되면 `accepted: false`로 바로 실패 (예전엔 `--wait`가 900초 멈추고 그 세션의 다음 이벤트도 다 `pending`에 묶였음) |
| `Stop` 직후 트랜스크립트에 마지막 답이 아직 없음 | CLI `send --wait` | 그 턴이 끝났다고 기록될 때까지 최대 5초 더 기다림 (예전엔 `auto_reply`가 빈 답이라 안 나갔음) |
| 잘못된 `DISCORD_TOKEN` | 디스코드 어댑터 | 에러 로그 + `/api/health`의 `discord`가 `failed: …` (예전엔 아무 흔적 없이 이벤트만 안 왔음) |
| 느린 웹소켓 구독자 | `Hub.publish` | 2초 넘으면 그 구독자만 끊음 |
| 라우트는 맞는데 세션이 `waiting` | `_deliver` | 전달 안 함, `deliveries.failed` "세션 상태 waiting" |
| 라우트는 맞는데 세션이 `starting` | `_deliver` → CLI | idle 될 때까지 `pending`으로 기다렸다가 전달 |
| 라우트는 맞는데 세션이 죽음 | `active_routes` | 애초에 후보에서 빠짐 (전달 기록도 없음) |
| 첨부 25MB 초과 / 다운로드 실패 | `_save_attachments` | 그 파일만 `error`, 전달은 계속 |
| `reply`에 모르는 이벤트 ID | `router.reply` | 404, CLI exit 1 |
| 그 플랫폼 어댑터 없음 | `router.reply` | `replies.failed` 기록 + 502 |
| 답장 API: 텍스트·파일 둘 다 없음 / 파일 11개 이상 / 파일 10MB 초과 | `app.py` `reply` | 400 / 413 / 413. 파일은 한도+1바이트까지만 읽어서 판단 |
| 디스코드 API 에러 (권한 없음 등) | `send_reply` | `replies.failed` + 502 |
| 서버가 꺼져 있을 때 `cardinal reply` | `serverInfo` / fetch | "서버 정보 없음" 또는 연결 실패, exit 1. 답장은 유실 (재시도 없음) |
| 서버가 꺼져 있을 때 훅 이벤트 | 훅은 파일만 씀 | 유실 없음. 다음 기동 때 오프셋부터 따라잡음 |
| `auto_reply` 대기 중 서버 재시작 | `_bg` 태스크 | 태스크 소멸, 자동 답장 안 됨. delivery는 `sent`로 남음 |
| 같은 세션에 이벤트 여러 개가 동시에 옴 | `_deliver` | 하나씩 차례로 (뒤에 온 건 `pending`으로 대기). 각자 자기 턴. **예전엔 한 프롬프트로 합쳐졌음 → 해결** |
| 세션이 오래 작업 중 | CLI `send` | idle 될 때까지 최대 600초 대기 후 실패 (`failed` "대기 시간 초과") |
| Esc 중단 / 백그라운드 알림 턴 | 훅 상태 | 상태가 `busy`에 멈춰서 전달이 idle 대기로 최대 600초 `pending` 후 `failed`, `auto_reply` 대기가 타임아웃까지 붙잡히거나, 엉뚱한 턴의 답이 나감 |
| `auto_reply`에서 send 자체가 실패 | `_deliver` | `pending` 행이 `failed`로 바뀜 (예전엔 `sent`+`failed` 두 행이 남았음 → 해결) |
| 붙여넣기 입력이라 에이전트가 지시를 덜 믿음 | claude | 지금까지 테스트에선 문제 없음. 생기면 전달 방식을 바꿔야 함 |

---

## 13. REST / 웹소켓 목록

| 메서드 | 경로 | 처리 |
| --- | --- | --- |
| GET | `/` | `static/index.html` |
| GET | `/api/sessions[?all=true]` | DB (`all`이면 삭제된 것도) |
| POST | `/api/sessions` | 흐름 A |
| GET | `/api/sessions/<이름>` | DB + 라우트 |
| DELETE | `/api/sessions/<이름>[?purge=true]` | `cardinal kill` → 즉시 sync |
| POST | `/api/sessions/<이름>/send` | `cardinal send - [--wait]` `{text, wait, timeout_s, submit, force, now}`. 기본은 idle 대기, `now`면 바로 |
| POST | `/api/sessions/<이름>/keys` | `cardinal keys` `{keys: [...]}` |
| GET | `/api/sessions/<이름>/screen?lines=` | `cardinal screen` |
| GET | `/api/sessions/<이름>/report` | `cardinal report --json` |
| GET | `/api/sessions/<이름>/events?limit=` | DB `session_events` |
| GET/POST | `/api/sessions/<이름>/routes` | DB `routes` |
| DELETE | `/api/routes/<id>` | DB |
| GET | `/api/health` | `{ok, channels: {local, discord: off/connecting/ready/failed: …}, sessions}` |
| GET | `/api/events?limit=` | DB 채널 이벤트 + 전달 + 답장 |
| POST | `/api/channel/inbound` | 흐름 C (local) |
| POST | `/api/events/<id>/reply` | 흐름 D (멀티파트: text, session, files). 최대 10개, 각 10MB |
| WS | `/ws/term/<이름>?cols=&rows=[&readonly=1]` | 흐름 F |
| WS | `/ws/events` | 흐름 F |
| WS | `/ws/channel` | 흐름 F + local 입력 |

---

## 14. 디스코드 봇 설정

1. Developer Portal에서 앱 만들고 Bot 토큰 발급.
2. Bot → Privileged Gateway Intents → **MESSAGE CONTENT** 켜기 (안 켜면 `content`가 빈 문자열로 와서 트리거가 절대 안 맞음. 멘션만 됨).
3. OAuth2 URL Generator: scope `bot`, 권한 View Channels / Send Messages / Read Message History / Attach Files → 서버에 초대.
4. `DISCORD_TOKEN=... uv run cardinal-server`. 로그에 `디스코드 연결됨: <봇이름>`이 뜨고 `GET /api/health`의 `discord`가 `ready`면 OK. 토큰이 틀리면 `failed: LoginFailure: …`.
5. 라우트 예:
   ```json
   {"name":"helper","routes":[
     {"platform":"discord","channel":"dev","trigger":"!ask","match":"prefix"},
     {"platform":"discord","match":"mention","auto_reply":true}
   ]}
   ```

---

## 15. 테스트한 것 / 아직 안 된 것

테스트 (local 채널, 실제 claude 세션):

- 트리거 없는 메시지 → 저장만, 전달 없음. `!ask` 메시지 → 라우트 걸린 세션에만 전달.
- 첨부파일 → inbox 저장 → 에이전트가 `cat`으로 읽고 `cardinal reply`로 답장 (`42`).
- 에이전트가 파일 만들어서 `--file`로 첨부 답장 (`hello.csv`).
- `auto_reply` (`contains`) → Stop 후 약 0.5초에 자동 답장 (`21`).
- purge 후에도 DB에 세션(`deleted_at`), 훅 이벤트 14건, 답장 3건 남음.
- 토큰 인증 (HTTP 401/200, WS 거부/허용), 종료 시 `server.json` 정리.
- 웹 터미널 웹소켓: 출력 수신, 리사이즈, 입력.
- `cardinal reply` 에러: 모르는 이벤트 → "모르는 이벤트", 없는 파일 → "파일 없음".

아직:

- **디스코드는 실제 봇으로 안 돌려봄** (토큰 없음). 어댑터 코드만 있음.
- `auto_reply` 대기가 서버 재시작을 못 버팀.
- `cardinal reply` 실패 시 재시도/큐 없음.
- 라우트는 서버 API로만 붙일 수 있음. 마스터가 CLI로 만든 워커엔 못 붙임 → 필요하면 `cardinal route` 명령.
- 세션 전달이 붙여넣기 방식이라 claude가 `<pasted_content>`로 감쌈. 지시를 따르는 데 지금은 문제 없지만 지켜봐야 함.
