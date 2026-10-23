# 웹 UI

[English](web-ui.en.md) · 관련: [서버](server.md), [웹 터미널은 어떻게 도는가](web-terminal.md)

카디널을 브라우저에서 조작하는 화면. `web/` (Vite + React + TypeScript). 카디널 서버의 REST/웹소켓만 쓰고, **서버가 제공하는 옵션은 전부 화면에서 쓸 수 있음** (아래 대응표).

## 실행

```sh
cd web
pnpm install
pnpm build      # → web/dist. 카디널 서버가 / 에서 서빙 (서버 재시작 필요 없음)
pnpm dev        # 개발 서버 http://localhost:5173. /api, /ws 는 카디널 서버로 프록시
```

- 서버 주소는 기본 `http://127.0.0.1:7878`. 개발 서버에서 다른 서버를 보려면 `CARDINAL_URL=http://… pnpm dev`.
- 빌드 위치를 바꾸려면 서버를 `CARDINAL_WEB_DIST=/경로/dist`로 띄움.
- 빌드 안 된 상태로 `/`를 열면 빌드 방법 안내 페이지가 나옴.

## 서버 기능 ↔ 화면

| 서버 | 옵션 | 화면 |
| --- | --- | --- |
| `GET /api/health` | 채널 상태, 세션 수 | 상단 칩 (디스코드 off/connecting/ready/실패), 10초마다 |
| `GET /api/sessions` | `all` (삭제된 것 포함) | 왼쪽 목록, "삭제된 것도" |
| `POST /api/sessions` | `name`, `role`, `cwd`, `trust`, `prompt`, `args`, `routes[]` | "새 세션" 창의 모든 칸 |
| `DELETE /api/sessions/<이름>` | `purge` | "종료" / "종료 + 기록 삭제" |
| `POST …/send` | `text`, `wait`, `timeout_s`, `submit`, `now`, `force` | 보내기 탭: 응답 기다리기 + 최대 초, 붙여넣기만(Enter 안 누름), 바로 끼워넣기, 강제 |
| `POST …/keys` | 임의 tmux 키 | 보내기 탭: 자주 쓰는 키 버튼 + 키 직접 입력 |
| `GET …/screen` | `lines` (스크롤백) | 화면 탭: 스크롤백 선택, 2초 자동 새로고침 |
| `GET …/report` | phase, 마지막 사람 턴, 도구 | 결과 탭 (도구 호출 보기 선택) |
| `GET …/events` | `limit` | 훅 이벤트 탭: 개수 100/300/1000/5000 |
| `GET/POST …/routes`, `DELETE /api/routes/<id>` | `platform`, `channel`, `trigger`, `match`, `auto_reply` | 라우트 탭 (목록·추가·삭제), 새 세션 창 |
| `GET /api/events` | `limit` | 채널 화면: 개수 20/50/200/500 |
| `POST /api/channel/inbound` | `content`, `channel`, `author`, `mentions_bot` | 채널 화면 "넣기" + "봇 멘션" |
| `WS /ws/channel` 메시지 넣기 | `attachments` (base64) | 채널 화면 "넣기"에 파일 첨부 (첨부가 있으면 웹소켓으로 보냄) |
| `POST /api/events/<id>/reply` | `text`, `files[]`, `session` | 이벤트마다 "직접 답장" (파일 첨부, 보낸 세션 선택) |
| `WS /ws/term/<이름>` | `cols`, `rows`, `readonly` | 터미널 탭 (창 크기 자동), "관전 모드" |
| `WS /ws/events` | 세션 목록 푸시 | 목록·상태 실시간 갱신, 상세 탭 다시 불러오기 |
| `WS /ws/channel` 알림 | `event`, `delivery`, `reply`(local 첨부 본문), `reply_saved` | 채널 화면 실시간 갱신, local 답장 첨부 내려받기 |
| 토큰 (`CARDINAL_TOKEN`) | `?token=`, `Authorization: Bearer` | 상단 "토큰", 401이면 자동으로 입력 창 |

세션의 모든 필드(고유 키, tmux, 지금 claude 세션 ID, 작업 폴더, 만든 세션(마스터, 목록에도 `↳ 마스터`로 표시), 트랜스크립트 경로, claude 추가 인자, 상태·마지막 훅 이벤트·도구, 만든 시각)는 세션 상세의 "세션 정보"에서 볼 수 있음.

## 화면

```
┌ 상단: Cardinal · [세션] [채널] ····· 실시간 ● · 살아있음 n · 작업 중 n · 디스코드 상태 · 토큰 ┐
├ 왼쪽: [+ 새 세션] / 세션 목록 (상태 점, 역할, 상태, 작업 폴더) ┬ 오른쪽: 선택한 세션 또는 채널 ┤
```

### 세션 목록

`/ws/events`로 실시간 갱신. 상태 점: 대기(초록), 작업 중(주황, 도구 이름), 승인 대기(빨강), 준비 중/사람이 중단함(파랑), 종료(회색). "삭제된 것도"를 켜면 purge된 세션의 DB 기록도 보임 (선택은 안 됨).

### 세션 상세 (탭)

| 탭 | 하는 일 |
| --- | --- |
| 터미널 | tmux 화면에 직접 붙음. "관전 모드"면 입력 안 받고 창 크기에도 영향 없음 |
| 화면 | tmux 화면을 텍스트로 (터미널에 안 붙음). 스크롤백 줄 수, 2초 자동 새로고침. Claude Code는 대체 화면을 써서 tmux 스크롤백이 거의 없음 → 대화 전체는 결과 탭 |
| 보내기 | 메시지: 응답 기다리기(최대 초 지정, 넘으면 부분 응답) / 붙여넣기만 / 바로 끼워넣기 / 강제. 16,000바이트 한도 표시 (tmux 제약). 키: Enter, Esc(중단), ↑↓, 신뢰 수락(Down Enter), Ctrl+C, 그리고 직접 입력 |
| 결과 | 지금 상태(phase) + 마지막 사람 턴의 지시와 응답 전체. 도구 호출 목록 선택. 중단/진행 중이면 표시. 붙여넣기 감싸기(`<pasted_content>`)는 벗겨서 보여줌 |
| 훅 이벤트 | 훅 이벤트 기록 (개수 선택) |
| 라우트 | 라우트 목록, 추가, 삭제 |

결과·훅 이벤트 탭은 세션 목록이 바뀔 때(`/ws/events` 알림)마다 다시 불러옴.

### 채널

- 받은 이벤트마다: 이벤트 ID, 본문, 첨부(크기, 저장 실패), 전달(대기/전달/실패 + 사유), 답장(답장/자동 답장, 실패 사유, 첨부 이름).
- "직접 답장": 텍스트 + 파일(최대 10개, 각 10MB) + 보낸 세션(기록용, 자동 답장 중복 방지에도 씀). 원래 메시지에 답장으로 감.
- local 채널 넣기: 채널·작성자·내용 + 봇 멘션 + 첨부파일. 첨부 없으면 REST로 넣고 매칭된 세션을 바로 보여줌, 첨부가 있으면 `/ws/channel`로 넣고 결과는 목록에서 확인.
- local 채널 답장의 첨부파일은 DB에 본문이 없어서, 화면이 열려 있는 동안 `/ws/channel`로 받은 것만 "⬇ 파일 이름" 링크로 내려받을 수 있음.

### 토큰

서버를 `CARDINAL_TOKEN`으로 띄웠으면 주소에 `?token=…`을 붙여 한 번 열거나(이 브라우저에 저장하고 주소창에서 지움) 상단 "토큰" 버튼으로 입력. API가 401을 주면 입력 창이 자동으로 뜸. REST는 `Authorization: Bearer`, 웹소켓은 쿼리 `?token=`. 정적 파일은 토큰 없이 받음 (비밀 없음).

### 주소로 화면 고르기

`/#s=<세션 이름>` (세션 상세), `/#channel` (채널). 지금 화면이 주소 해시에 반영돼서 새로고침·북마크해도 그대로.

## 파일

| 파일 | |
| --- | --- |
| `web/src/api.ts` | API 클라이언트, 토큰, 웹소켓 주소, 답장 멀티파트, 첨부 base64, 16KB 한도 |
| `web/src/types.ts` | 서버 응답 타입 |
| `web/src/hooks.ts` | 재연결되는 JSON 웹소켓 구독, 주기 실행 |
| `web/src/App.tsx` | 전체 구성, 세션 목록 실시간 갱신, 토큰, 주소 해시 |
| `web/src/components/SessionList.tsx` | 세션 목록 |
| `web/src/components/CreateSession.tsx` | 새 세션 |
| `web/src/components/SessionView.tsx` | 세션 상세, 세션 정보, 탭 (터미널은 필요할 때만 불러옴) |
| `web/src/components/SessionPanels.tsx` | 화면 / 보내기 / 결과 / 훅 이벤트 / 라우트 |
| `web/src/components/TerminalView.tsx` | xterm.js + `/ws/term` |
| `web/src/components/ChannelPanel.tsx` | 채널 이벤트, 직접 답장, local 넣기, local 답장 첨부 내려받기 |
| `web/src/styles.css` | 라이트/다크, 좁은 화면 |

## 확인한 것

실제 Chrome(Playwright)으로 끝까지 조작해서 확인, 브라우저 콘솔 에러 없음:

- 터미널 연결과 화면 수신 / 화면 탭(스크롤백 선택) / 세션 정보
- 보내기 → 응답 "7" / 붙여넣기만 → Enter 키 → "5" / 최대 2초 → "시간 초과(부분 응답)" / 키 직접 입력 `Escape` → "사람이 중단함" / 16KB 초과 시 버튼 비활성 + 안내
- 결과 · 훅 이벤트(개수 선택) · 라우트(추가: @멘션 + 자동 답장)
- 새 세션 (커스텀 폴더 + 신뢰 자동 수락) → 대기
- 채널: local 넣기 → 자동 답장 "8" / 봇 멘션 넣기 → 멘션 라우트 세션 매칭 → 자동 답장 / 첨부파일 넣기 → 세션이 파일을 읽고 답 / 직접 답장(파일) → 기록 + local 답장 첨부 내려받기(내용 일치)
- 라이트 모드, 모바일 폭(390px)

## 알아둘 것

- 터미널의 한글은 칸 2개를 차지함. 브라우저에 칸 폭에 맞는 한글 고정폭 폰트(D2Coding 등)가 없으면 자간이 벌어져 보임.
- 첫 로딩은 약 250KB(gzip 78KB), 터미널 탭(xterm)은 열 때 약 330KB(gzip 84KB)를 더 받음.
- 라우트 켜기/끄기(`enabled`)는 DB에 칼럼만 있고 서버 API가 없어서 화면에도 없음 (추가·삭제로 대신).
