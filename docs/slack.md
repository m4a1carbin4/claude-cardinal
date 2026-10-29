# 슬랙 채널

[English](slack.en.md) · 관련: [서버](server.md) (채널·라우트·답장 흐름), [카디널 MCP](mcp.md)

디스코드처럼 슬랙 메시지를 라우트 따라 세션에 넘기고, 세션이 `mcp__cardinal__reply`(또는 `cardinal reply`)로 답함. 라우트·자동 답장·첨부 저장은 디스코드와 같은 걸 씀 ([서버](server.md) 흐름 C~E). 서버가 떠 있을 때만 있음.

**Socket Mode**로 붙음: 서버가 슬랙에 웹소켓으로 먼저 접속해서 이벤트를 받음. 그래서 공개 URL(Request URL)이 필요 없고 서버가 127.0.0.1 에만 떠 있어도 됨.

## 켜기

토큰 두 개가 다 있어야 켜짐. 하나만 있으면 경고 로그만 남기고 꺼짐.

| 환경변수 | |
| --- | --- |
| `SLACK_BOT_TOKEN` | 봇 토큰 `xoxb-…`. 메시지 보내기, 채널·사용자 이름, 파일 받기/올리기 |
| `SLACK_APP_TOKEN` | 앱 토큰 `xapp-…` (scope `connections:write`). Socket Mode 접속 |

```sh
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… uv run cardinal-server
# launchd 로 띄운 서버면 토큰을 넣고 다시 설치 (plist 에 평문으로 들어감)
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… ./autostart.sh install --sdk
```

로그에 `슬랙 연결됨: <봇 이름> (<워크스페이스>)`가 뜨고 `GET /api/health`의 `channels.slack`이 `ready`면 OK. 토큰이 틀리면 `failed: SlackApiError: invalid_auth` 처럼 슬랙 오류 코드가 보이고 슬랙만 꺼짐 (서버는 그대로). 웹 UI 위쪽에도 "슬랙" 상태가 뜸 (꺼져 있으면 안 보임).

## 슬랙 앱 만들기

1. https://api.slack.com/apps → **Create New App** → **From a manifest** → 워크스페이스 고르기 → 아래 YAML 붙여넣기 → Create.
2. **Basic Information → App-Level Tokens → Generate Token and Scopes**: 이름 아무거나, scope `connections:write` → 나온 `xapp-…`가 `SLACK_APP_TOKEN`.
3. **Install App → Install to Workspace** → 허용 → 나온 **Bot User OAuth Token** `xoxb-…`가 `SLACK_BOT_TOKEN`.
4. 봇이 메시지를 볼 채널에서 `/invite @Cardinal`. 봇이 들어간 채널 메시지만 옴 (DM 은 바로 됨).

```yaml
display_information:
  name: Cardinal
features:
  bot_user:
    display_name: Cardinal
    always_online: true
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - channels:read
      - groups:read
      - im:read
      - mpim:read
      - users:read
      - chat:write
      - files:read
      - files:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

권한이 하는 일: `*:history` + `message.*` 이벤트 = 메시지 받기, `app_mentions:read` = 멘션 받기, `*:read`·`users:read` = 채널·사람 이름, `chat:write` = 답장, `files:read`/`files:write` = 첨부 받기/올리기. 멘션만 받고 싶으면 `message.*`와 `*:history`를 빼도 됨 (그럼 `match: mention` 라우트만 맞음). 권한을 바꾸면 앱을 다시 설치해야 함.

## 라우트

```json
{"platform":"slack","channel":"dev","trigger":"!ask","match":"prefix"}
{"platform":"slack","match":"mention","auto_reply":true}
```

- `channel`은 채널 이름(`dev`, `#dev`) 또는 ID(`C0123…`). DM 은 이름이 `dm`.
- `mention`은 봇을 `@`한 메시지. 본문에서 `<@U…>` 멘션은 떼고 넘김.
- 웹 UI 라우트 입력의 플랫폼에 `slack`이 있음. `platform: "*"`면 디스코드·슬랙·local 다 맞음.

## 받는 메시지

`message`(채널, 비공개 채널, DM, 그룹 DM)와 `app_mention` 이벤트를 받아서 `InboundMessage`로 바꿈.

| 필드 | 값 |
| --- | --- |
| `channel_id` / `channel_name` | 채널 ID / 이름 (`conversations.info`, 기억해 둠). DM 은 `dm` |
| `guild` | 워크스페이스 이름 |
| `author` | 표시 이름 → 실명 → 사용자 이름 순 (`users.info`, 기억해 둠) |
| `message_id` | **답장할 스레드 ts**: 스레드 안이면 그 스레드, 채널 메시지면 그 메시지 ts, DM 은 비움 |
| `mentions_bot` | `app_mention` 이거나 본문에 `<@봇>`이 있으면 |
| `content` | 링크 `<url\|글>` → `url`, `<#C1\|이름>` → `#이름`, `&amp;`·`&lt;`·`&gt;` 되돌림 |
| 첨부 | `url_private_download`를 봇 토큰으로 받음. `files:read`가 없으면 슬랙이 로그인 페이지(html)를 200 으로 줘서 그걸 오류로 잡음 |

- 무시: 봇 메시지(자기 자신 포함, 답장 루프 방지), 수정·삭제·입장 같은 subtype (`file_share`, `thread_broadcast`는 받음).
- 멘션은 `message`와 `app_mention`이 둘 다 오고, 슬랙이 같은 이벤트를 다시 보내기도 해서 (채널, ts)로 한 번만 처리.
- 슬랙은 3초 안에 ack 를 받아야 해서 받자마자 ack 하고 처리함.

## 답장

- 채널 메시지에는 **그 메시지 스레드**로 답함 (채널을 안 어지럽히게). 스레드 안에서 온 건 그 스레드로. DM 은 스레드 없이.
- 글은 4000자씩 나눠 보냄 (슬랙 권장 길이). 파일은 `files_upload_v2`로 같은 스레드에 올림.
- 파일 한도는 CLI·답장 API 의 기존 한도(10개, 각 10MB)를 그대로 씀.
- 돌려받는 ID 는 보낸 메시지 ts 들과 올린 파일 ID.

## 파일

| 파일 | |
| --- | --- |
| `server/cardinal_server/channel/slack_adapter.py` | Socket Mode 접속, 이벤트 → `InboundMessage`, 답장 |
| `server/cardinal_server/app.py` | 토큰 있으면 어댑터 시작, `/api/health`의 `slack` |
| `server/cardinal_server/router.py` | 멘션 떼기 (`<@U…>`, `<@U…\|이름>`) |

## 확인한 것 / 안 한 것

- 슬랙 API 를 가짜로 바꿔서: 채널 메시지·멘션 중복·봇 메시지·수정 이벤트·스레드·DM+파일 변환, 라우트 매칭(mention, prefix), 4000자 나누기, 스레드 답장, DM 답장, 파일 올리기 인자
- 로컬 HTTP 서버로 첨부 받기 (Bearer 토큰, 로그인 페이지면 오류)
- 가짜 토큰으로 서버 시작 → 서버는 뜨고 `slack: failed: SlackApiError: invalid_auth`
- **실제 슬랙 워크스페이스로는 아직 안 돌려봄** (토큰 없음)
