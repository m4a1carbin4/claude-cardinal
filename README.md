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

## 할 일

- [x] tmux + WebSocket 터미널 붙여서 Claude Code 띄우기
- [x] 세션 목록 / ID / 히스토리 관리
- [x] 워커 / 마스터 구분
- [x] 마스터가 세션 띄워서 일 넘기기
- [x] 서버 분리 (Python FastAPI) + 세션 기록 SQLite
- [x] 이벤트 채널 (디스코드 봇 + local) + 세션별 라우트 (채널명, 트리거)
- [x] 세션 안 에이전트가 이벤트에 직접 답장 (`cardinal reply`, 파일 첨부)
- [x] 세션별 훅 폴더 (고유 키 기준) → 이름 재사용 / `/clear` / purge 꼬임 해결
- [x] 세션별 `send` 직렬화 (세션 락 + idle 대기 → 메시지 하나 = 턴 하나)
- [x] 상태 판정 보강 (Esc 중단 = 사람 개입, 백그라운드 알림 턴 구분, 사람 입력만 턴으로 보기)
- [x] 서버 시작 전 중복 실행/포트 확인
- [ ] 디스코드 실제 봇으로 돌려보기
- [ ] 카디널 캐릭터성

## 실행 방법

필요한 거: tmux, node 22+, pnpm, claude, (서버) python 3.12+ / uv

```sh
pnpm install && pnpm build
ln -s "$PWD/bin/cardinal" ~/.local/bin/cardinal   # 선택. PATH 어딘가에
```

### 세션 굴리기

```sh
cardinal new w1                                  # 워커 하나 띄우기
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
```

세션은 전부 고정 작업 폴더 하나에서 돔: `$CARDINAL_WORKSPACE` (기본 `~/.cardinal/workspace`).
그래서 트랜스크립트 경로가 세션 ID만으로 정해짐.

상태는 Claude Code 훅으로 찍음: `starting → idle ⇄ busy`, 승인 기다리면 `waiting`, 꺼지면 `ended`.
기록: `~/.cardinal/sessions/<이름>/meta.json` (이름 ↔ 세션 고유 키) + `~/.cardinal/hooks/<고유 키>/` (훅 전용 폴더: `state.json`, `events.jsonl`).

작업 폴더 처음 쓸 땐 신뢰 다이얼로그가 떠서 `starting`에 멈춤 → `cardinal keys <이름> Down Enter` 한 번이면 이후론 안 뜸.

### 서버 (웹, DB, 메시지 채널)

```sh
cd server && uv sync
uv run cardinal-server                     # http://127.0.0.1:7878
DISCORD_TOKEN=xxx uv run cardinal-server   # 디스코드 봇도 같이
CARDINAL_TOKEN=xxx uv run cardinal-server  # 토큰 걸기 (?token=xxx 또는 Bearer)
```

- 웹 터미널, 세션 생성할 때 채널 라우트 (채널명 + 트리거) 붙이기
- 세션 기록은 `~/.cardinal/cardinal.db` (SQLite)에 쌓임. purge해도 DB엔 남음
- 상태 확인: `GET /api/health` (디스코드 연결 상태 포함)
- 라우트에 맞는 디스코드 메시지 → 세션에 전달 → 세션 안 에이전트가 답장:

```sh
cardinal reply evt_71363e3e "답장" --file result.png
```

API랑 채널 자세한 건 [docs/server.md](docs/server.md).
