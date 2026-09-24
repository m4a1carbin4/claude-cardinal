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

## 할 일

- [x] tmux + WebSocket 터미널 붙여서 Claude Code 띄우기
- [x] 세션 목록 / ID / 히스토리 관리
- [x] 워커 / 마스터 구분
- [x] 마스터가 세션 띄워서 일 넘기기
- [ ] 이벤트 채널 + 외부 메시지 서버 연동
- [ ] 세션별 이벤트 수신 옵션

## 실행 방법

필요한 거: tmux, node 22+, pnpm, claude

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
기록은 `~/.cardinal/sessions/<이름>/` 에 (`meta.json`, `state.json`, `events.jsonl`).

작업 폴더 처음 쓸 땐 신뢰 다이얼로그가 떠서 `starting`에 멈춤 → `cardinal keys <이름> Down Enter` 한 번이면 이후론 안 뜸.

### 웹

```sh
cardinal serve                         # http://127.0.0.1:7878
CARDINAL_TOKEN=xxx cardinal serve      # 토큰 걸기 (?token=xxx 또는 Bearer)
```

- `GET  /` 웹 터미널 (세션 목록 + xterm.js)
- `WS   /ws/term/<이름>?cols=&rows=[&readonly=1]` 터미널 I/O
  - 보내기: `{"t":"i","d":"입력"}`, `{"t":"r","c":120,"r":40}` (리사이즈)
  - 받기: 바이너리 프레임 = 터미널 출력 그대로
- `WS   /ws/events` 상태 바뀔 때마다 `{"type":"sessions","sessions":[...]}`
- `GET/POST /api/sessions`, `GET/DELETE /api/sessions/<이름>`
- `POST /api/sessions/<이름>/send` `{"text","wait","timeoutMs","submit","force"}`
- `POST /api/sessions/<이름>/keys` `{"keys":["Enter"]}`
- `GET  /api/sessions/<이름>/screen?lines=`, `GET /api/sessions/<이름>/last`, `GET /api/sessions/<이름>/report`
