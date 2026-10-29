<div align="center">

<img src="assets/banner.png" alt="Claude Cardinal" width="320" />

# Claude Cardinal

Claude Code 세션들 굴리는 취미용 오케스트레이터

</div>

---

## 이게 뭐냐면

소아온(SAO) 카디널 시스템에서 이름 따온 개인 취미 프로젝트.
Claude Code 세션 여러 개 띄워놓고 쓰다 보니 관리가 귀찮아서, 카디널이 알아서 챙기게 만들어볼까 함.

## 대충 이런 거 할 생각

- **세션마다 tmux 터미널 하나**
  Claude Code 세션 띄우면 WebSocket으로 붙는 tmux 터미널도 하나씩 같이 뜨게.

- **워커 / 마스터**
  - 워커: 자기 일만 함.
  - 마스터: 다른 세션 만들고 일 시킬 수 있음.

- **서브 에이전트 말고 진짜 세션으로**
  마스터는 Claude Code 내장 서브 에이전트나 워크플로 대신 tmux 세션 따로 띄워서 일 넘기기. 그래야 뭐 하는지 눈에 보이니까.
  (따로 요청하거나 워커 세션이면 내장 기능 써도 됨.)

- **모델은 카디널 MCP로만**
  서버가 떠 있으면 세션 안 모델(tmux든 SDK든)은 서버의 카디널 MCP 도구(`mcp__cardinal__*`)로만 카디널을 다룸. 워커는 답장·목록만, 마스터는 세션 만들기/보내기/기다리기까지. `cardinal` CLI는 사람이 직접 개입할 때용.

- **카디널**
  tmux 셸 목록, Claude Code 세션 ID, 세션 히스토리 다 들고 있고, 세션 만들고 지우고 고칠 수 있는 본체.

- **이벤트 채널 하나**
  카디널은 이벤트 채널 딱 하나만 갖고, 외부 메시지 서버 에이전트랑 연결. 이벤트는 항상 듣고 있기.

- **세션도 이벤트 받을 수 있게**
  카디널이 만든 세션은 옵션으로 특정 이벤트 메시지 받고, 답장은 한 채널로 모아서 보내기.

## 구조

```
외부 메시지 서버 에이전트
        │
        ▼
   ┌──────────┐
   │  카디널  │  ← 이벤트 채널 하나
   └──────────┘
        │  세션 생성 / 삭제 / 수정
        ▼
  마스터 세션 ──(일 시키기)──▶ 워커 세션들
  (Claude Code + tmux)          (Claude Code + tmux)
```

자세한 건:
- [세션 시스템](docs/session-system.md) ([English](docs/session-system.en.md))
- [웹 터미널은 어떻게 도는가](docs/web-terminal.md) ([English](docs/web-terminal.en.md))
- [카디널 서버: DB, 메시지 채널](docs/server.md) ([English](docs/server.en.md))
- [웹 UI](docs/web-ui.md) ([English](docs/web-ui.en.md))
- [SDK 모드: tmux 없이 서버 안 Agent SDK 세션](docs/sdk-mode.md) ([English](docs/sdk-mode.en.md))
- [카디널 MCP: 세션 안 모델이 카디널을 다루는 길](docs/mcp.md) ([English](docs/mcp.en.md))

## 할 일

- [x] tmux + WebSocket 터미널 붙여서 Claude Code 띄우기
- [x] 세션 목록 / ID / 히스토리 관리
- [x] 워커 / 마스터 구분
- [x] 마스터가 세션 띄워서 일 넘기기
- [x] 서버 분리 (Python FastAPI) + 세션 기록 SQLite
- [x] 이벤트 채널 (디스코드 봇 + 슬랙 봇 + local) + 세션별 라우트 (채널명, 트리거)
- [x] 세션 안 에이전트가 이벤트에 직접 답장 (`cardinal reply`, 파일 첨부)
- [x] 세션별 훅 폴더 (고유 키 기준) → 이름 재사용 / `/clear` / purge 꼬임 해결
- [x] 세션별 `send` 직렬화 (세션 락 + idle 대기 → 메시지 하나 = 턴 하나)
- [x] 상태 판정 보강 (Esc 중단 = 사람 개입, 백그라운드 알림 턴 구분, 사람 입력만 턴으로 보기)
- [x] 서버 시작 전 중복 실행/포트 확인
- [x] SDK 모드: tmux 없이 서버 안 Claude Agent SDK 세션 (생성/재시작/중단, 질문 답하기, MCP, 실시간 웹소켓, 같은 채널)
- [x] SDK 모드 웹 UI (대화 실시간, 질문/권한 답하기, MCP 상태, 설정·다시 시작)
- [x] 카디널 MCP: 서버 안 MCP 하나를 tmux·SDK 세션이 같이 씀 (역할별 도구, 세션 키, 서버 재시작 때 다시 붙이기)
- [ ] 디스코드·슬랙 실제 봇으로 돌려보기
- [ ] 카디널 캐릭터성

## 실행 방법

필요한 거: tmux, node 22+, pnpm, claude, (서버) python 3.12+ / uv, (웹 UI) 같은 node/pnpm

```sh
./install.sh                      # 도구 확인 → CLI·서버·웹 UI 빌드 → ~/.local/bin/cardinal 연결
./install.sh --bin-dir DIR        # 연결 위치 바꾸기 (--no-link, --no-web 도 있음)
./launch.sh                       # 내부 서버(127.0.0.1:7878) + 웹 UI http://127.0.0.1:5173
./launch.sh --host 0.0.0.0 -p 8080   # 웹 UI 주소/포트 (밖에 열 땐 CARDINAL_TOKEN 권장)
```

`launch.sh`는 서버를 127.0.0.1 에만 띄우고 웹 UI(vite)가 `/api`, `/ws`를 서버로 넘김. 이미 떠 있는 서버가 있으면 그걸 쓰고 끝날 때도 안 끔. `--server-port`, `--dev`(개발 모드), `--rebuild`도 있음. 시작할 때 소스(CLI `src/`, 웹 `web/src/` 등)가 빌드보다 새로우면 알아서 다시 빌드함 (빌드가 실패하면 예전 빌드로 뜸). 그래서 코드를 고치거나 `git pull` 한 뒤엔 다시 띄우기만 하면 됨 (launchd 로 띄웠으면 `launchctl kickstart -k gui/$(id -u)/claude-cardinal`).

수동으로 하려면:

```sh
pnpm install && pnpm build
ln -s "$PWD/bin/cardinal" ~/.local/bin/cardinal   # 선택. PATH 어딘가에
```

### 세션 굴리기

```sh
cardinal new w1                                  # 워커 하나 띄우기 (기본 작업 폴더)
cardinal new w4 --cwd ~/repo/app --trust         # 작업 폴더 지정 (처음 쓰는 폴더면 --trust)
                                                 # 마스터 안에서 new 하면 기본이 마스터의 작업 폴더
cardinal new boss --role master                  # 마스터
cardinal new w2 --prompt "테스트 돌려봐" --wait   # 첫 지시 주고 끝날 때까지 대기
cardinal new w3 -- --model sonnet               # -- 뒤는 claude 인자 그대로

cardinal ls                                      # 목록 + 상태
cardinal send w1 "README 읽고 요약해" --wait      # 보내고 끝나면 마지막 응답 출력
cardinal keys w1 Down Enter                      # 다이얼로그 같은 거 키로 처리
cardinal screen w1                               # 지금 화면
cardinal report w1                               # 살아있나? 작업중/완료? + 마지막 턴 응답 전체
cardinal last w1                                 # 마지막 턴 응답 텍스트만
cardinal attach w1                               # tmux로 직접 붙기
cardinal kill w1 --purge
cardinal revive w1                               # tmux 가 없어진 세션(재부팅 등)을 같은 세션·같은 대화로 (서버는 뜰 때 알아서 --all)
```

작업 폴더는 기본이 고정 워크스페이스 `$CARDINAL_WORKSPACE` (기본 `~/.cardinal/workspace`), `--cwd`로 세션마다 바꿀 수 있음.
기록(meta, 훅)은 작업 폴더와 상관없이 항상 `~/.cardinal` 아래.

상태는 Claude Code 훅으로 찍음: `starting → idle ⇄ busy`, 승인 기다리면 `waiting`, 꺼지면 `ended`.
기록: `~/.cardinal/sessions/<이름>/meta.json` (이름 ↔ 세션 고유 키) + `~/.cardinal/hooks/<고유 키>/` (훅 전용 폴더: `state.json`, `events.jsonl`).

처음 쓰는 작업 폴더는 신뢰 다이얼로그가 뜸 → `--trust`로 만들거나 `cardinal keys <이름> Down Enter`. 다이얼로그에 걸려 있으면 `send`/`wait`가 바로 알려줌.

카디널 서버가 떠 있으면 `new`가 세션에 카디널 MCP를 붙이고 모델은 그것만 씀 (`--no-mcp`면 안 붙이고 모델도 CLI를 씀). 서버가 다시 뜨면 살아있는 세션에 서버가 알아서 `cardinal mcp-reconnect`. 자세한 건 [docs/mcp.md](docs/mcp.md).

### 서버 (웹, DB, 메시지 채널)

```sh
cd server && uv sync
uv run cardinal-server                     # http://127.0.0.1:7878
DISCORD_TOKEN=xxx uv run cardinal-server   # 디스코드 봇도 같이
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… uv run cardinal-server   # 슬랙 봇도 같이 (Socket Mode, docs/slack.md)
CARDINAL_TOKEN=xxx uv run cardinal-server  # 토큰 걸기 (?token=xxx 또는 Bearer)
```

- 웹 UI (아래), 세션 생성할 때 채널 라우트 (채널명 + 트리거) 붙이기
- 세션 기록은 `~/.cardinal/cardinal.db` (SQLite)에 쌓임. purge해도 DB엔 남음
- 상태 확인: `GET /api/health` (디스코드·슬랙 연결 상태 포함)
- 라우트에 맞는 디스코드 메시지 → 세션에 전달 → 세션 안 에이전트가 `mcp__cardinal__reply` 도구로 답장 (서버 없이 띄운 세션이나 사람은 CLI로):

```sh
cardinal reply evt_71363e3e "답장" --file result.png
```
- 세션 안 모델은 `/mcp/worker`, `/mcp/master`(카디널 MCP)로 카디널을 다룸 → [docs/mcp.md](docs/mcp.md)
- 슬랙: Socket Mode 라 공개 URL 없이 붙음. 채널 메시지는 그 스레드로 답장 → [docs/slack.md](docs/slack.md)
- 웹드라이브: 사람과 세션이 같이 쓰는 파일 공간 (`~/.cardinal/drive`, 세션마다 `/sessions/<이름>`, 공용 `/shared`). 웹에서 올리고 받고 고치고, 세션은 `drive_*` MCP 도구로 같은 CRUD, 요청에 파일 붙이기 → [docs/drive.md](docs/drive.md)

API랑 채널 자세한 건 [docs/server.md](docs/server.md).

### 웹 UI

```sh
cd web && pnpm install && pnpm build   # → web/dist, 카디널 서버가 / 에서 서빙 (서버 재시작 필요 없음)
pnpm dev                               # 개발: http://localhost:5173, /api·/ws 는 7878 서버로 프록시
```

세션 목록(실시간) · 새 세션(tmux / SDK, 작업 폴더, 신뢰 자동 수락, SDK 옵션, 라우트) · 세션별 터미널 / 메시지·키 보내기 / 결과 / 훅 이벤트 / 라우트 · SDK 세션은 대화(실시간, 질문·권한 답하기) / MCP / 설정 · 채널 이벤트→전달→답장 흐름과 local 메시지 넣기 · 디스코드 연결 상태.
· 드라이브(파일 올리기·받기·편집, 세션 폴더 탭, 요청에 파일 첨부).
주소 해시로 화면을 고를 수 있음: `/#s=<세션 이름>`, `/#channel`, `/#drive`. 자세한 건 [docs/web-ui.md](docs/web-ui.md).

### SDK 모드 (tmux 없이)

```sh
cd server && uv run cardinal-server --sdk    # 또는 ./launch.sh --sdk
```

세션을 tmux + TUI 대신 **서버 안 Claude Agent SDK**로 돌림. 음성/모션 같은 프로그램이 붙기 좋게 REST + `/ws/sdk/<이름>` 실시간 웹소켓으로만 다룸 (CLI 없음).
생성·재시작(대화 이어서)·중단, 질문(AskUserQuestion)에 API로 답하기, 외부 MCP 서버 연결/상태, 모델·권한 모드 바꾸기, 토큰 스트리밍. 기본 권한 모드는 auto.
채널(디스코드, local)·라우트·자동 답장은 tmux 세션과 같은 걸 씀. 답장은 `mcp__cardinal__reply` 도구. 웹 UI에서도 만들고, 대화하고, 질문에 답하고, MCP·옵션 바꿔서 다시 시작할 수 있음. 자세한 건 [docs/sdk-mode.md](docs/sdk-mode.md).
