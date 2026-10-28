# 웹 UI

[English](web-ui.en.md) · 관련: [서버](server.md), [웹 터미널은 어떻게 도는가](web-terminal.md), [SDK 모드](sdk-mode.md)

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
| `GET /api/health` | 채널 상태, 세션 수, `sdk` | 상단 칩 (디스코드 off/connecting/ready/실패, SDK 모드 · 살아있는 SDK 세션 수), 10초마다. 새 세션 창의 기본 백엔드 |
| `GET /api/sessions` | `all` (삭제된 것 포함) | 왼쪽 목록, "삭제된 것도" |
| `POST /api/sessions` | `name`, `role`, `cwd`, `trust`, `prompt`, `args`, `routes[]`, `backend`, `sdk{…}` | "새 세션" 창의 모든 칸 (`sdk`는 `setting_sources`만 빼고 전부) |
| `DELETE /api/sessions/<이름>` | `purge` | "종료" / "종료 + 기록 삭제" |
| `POST …/send` | `text`, `wait`, `timeout_s`, `submit`, `now`, `force` | 보내기 탭: 응답 기다리기 + 최대 초, 붙여넣기만(Enter 안 누름), 바로 끼워넣기, 강제. SDK 세션은 붙여넣기만·키·16KB 한도 없음 |
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
| `POST …/interrupt` (SDK) | | 상세 위 "중단", 대화 탭 "중단" |
| `POST …/restart` (SDK) | `resume`, `sdk{…}` | 상세 위 "다시 시작", 대화 탭(끝난 세션) "이어서 다시 시작 / 새 대화로 시작", 설정 탭 "옵션 바꿔서 다시 시작" |
| `GET …/pending`, `POST …/pending/<id>` (SDK) | `answers`, `allow`, `message` | 대화 탭 질문/권한 카드, 상세 위 "답 기다리는 질문 n" |
| `GET …/mcp`, `POST …/mcp/<서버>` (SDK) | `reconnect` / `enable` / `disable` | MCP 탭 |
| `POST …/model`, `…/permission-mode` (SDK) | `model`, `mode` | 설정 탭 "지금 세션에 바로 적용" |
| `GET …/context` (SDK) | | 설정 탭 컨텍스트 사용량 |
| `GET …/turns` (SDK) | `limit` | 대화 탭 지난 턴 (30개씩, "이전 턴 더 보기") |
| `WS /ws/sdk/<이름>` (SDK) | `hello`, `state`, `message`, `turn`, `pending(_done)`, `result` / 보내기 `send`, 실패하면 REST | 대화 탭 실시간 |
| `WS /ws/events` | 세션 목록 푸시 | 목록·상태 실시간 갱신, 상세 탭 다시 불러오기 |
| `WS /ws/channel` 알림 | `event`, `delivery`, `reply`(local 첨부 본문), `reply_saved` | 채널 화면 실시간 갱신, local 답장 첨부 내려받기 |
| 토큰 (`CARDINAL_TOKEN`) | `?token=`, `Authorization: Bearer` | 상단 "토큰", 401이면 자동으로 입력 창 |

세션의 모든 필드(고유 키, 방식, 카디널 도구(MCP / CLI), tmux, 지금 claude 세션 ID, 작업 폴더, 만든 세션(마스터, 목록에도 `↳ 마스터`로 표시), 트랜스크립트 경로, claude 추가 인자, 상태·마지막 훅 이벤트·도구, 만든 시각)는 세션 상세의 "세션 정보"에서 볼 수 있음.

## 화면

```
┌ 상단: Cardinal · [세션] [채널] [드라이브] ····· 실시간 ● · 살아있음 n · 작업 중 n · 디스코드 상태 · 토큰 ┐
├ 왼쪽: [+ 새 세션] / 세션 목록 (상태 점, 역할, 상태, 작업 폴더) ┬ 오른쪽: 선택한 세션 또는 채널 ┤
```

### 세션 목록

`/ws/events`로 실시간 갱신. 상태 점: 대기(초록), 작업 중(주황, 도구 이름), 승인 대기 / SDK는 답 대기(빨강), 준비 중/사람이 중단함(파랑), 종료(회색). SDK 세션은 이름 옆에 `SDK`. "삭제된 것도"를 켜면 purge된 세션의 DB 기록도 보임 (선택은 안 됨).

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

### SDK 세션

서버를 `--sdk`로 띄우면([SDK 모드](sdk-mode.md)) 상단에 "SDK 모드" 칩이 뜨고, 새 세션 창의 기본 백엔드가 SDK가 됨. 새 세션 창에서 SDK를 고르면 trust·claude 인자 대신 SDK 옵션이 나옴: 권한 모드, 모델, Claude in Chrome(전역 설정 따름/켜기/끄기), 추가 시스템 프롬프트, 외부 MCP 서버(JSON), strict / 글자 단위 스트리밍 / 서버 시작 때 자동 재개, "고급 옵션"(예비 모델, effort, 허용·금지 도구, 최대 턴·비용, 질문 답 제한 시간, 추가 폴더, 환경변수). 잘못된 JSON·상대 경로·`KEY=VALUE` 아닌 줄은 보내기 전에 막음.

SDK 세션 상세는 탭이 다름: **대화 · 보내기 · 결과 · 훅 이벤트 · MCP · 설정 · 라우트** (터미널·화면 없음). 위쪽에 권한 모드·모델, "중단", "다시 시작" 버튼, 답 기다리는 질문이 있으면 그 수가 뜸 (누르면 대화 탭). "종료"는 나중에 다시 시작할 수 있고, "종료 + 기록 삭제"는 삭제 표시라 다시 못 씀.

| 탭 | 하는 일 |
| --- | --- |
| 대화 | `/ws/sdk/<이름>`로 실시간. 지난 턴(DB `sdk_turns`)은 말풍선: 보낸 지시, 도구 n회(펼치기), 응답, 시각·걸린 시간·비용·중단/오류. 지금 턴은 들어오는 대로: 글, 도구 호출 + 결과(실패는 빨강), `partial`이면 글자가 생기는 대로 (점선 말풍선). 보낸 메시지는 차례 기다리는 동안 점선으로. 맨 아래 보고 있을 때만 따라 내려감 |
| 질문 카드 | AskUserQuestion: 질문마다 선택지 버튼(설명 포함, `multiSelect`면 여러 개 → `, `로 이어서), 직접 입력(쓰면 선택 대신). "답하기" / "답 안 함 (스스로 판단)" |
| 권한 카드 | `default` 등 auto가 아닌 모드에서 도구 권한: 입력 JSON, 거부 사유(선택), "허용" / "거부" |
| 입력창 | Enter 보내기, Shift+Enter 줄바꿈 (한글 조합 중 Enter는 무시). 바로 끼워넣기 / 강제. 작업 중이면 "중단". 세션이 끝나 있으면 입력창 대신 "이어서 다시 시작 / 새 대화로 시작" |
| 보내기 | tmux와 같은 화면에서 붙여넣기만·키·바이트 한도만 뺀 것. `wait`로 응답까지 받아 보기 |
| 결과 | tmux와 같음 + 걸린 시간·비용, 오류로 끝난 턴 표시, 답 기다리는 질문 수 |
| MCP | 서버마다 상태(connected/failed/needs-auth/pending/disabled), scope, 서버 정보, 오류, 도구 목록(펼치기). cardinal 말고는 "다시 연결", "켜기/끄기" |
| 설정 | 모델·권한 모드 바로 적용 (다음 다시 시작 때도 유지). 컨텍스트 사용량 막대 + 항목별 토큰. 옵션 폼(지금 값으로 채워짐)으로 "이어서 다시 시작" / "새 대화로 다시 시작" / "되돌리기". 저장된 옵션 JSON |

설정 탭의 옵션 폼은 서버가 가려서 준 값(`env`, MCP `env`/`headers`의 `***`)으로 채워짐. 그대로 두고 다시 시작하면 서버가 원래 값을 씀 (고친 값만 바뀜). 서버 → 브라우저로는 비밀 값이 안 옴 (`/ws/events` 푸시도 가림).

### 음성 입력 (SDK 대화 탭)

입력창 위 🎤 버튼: 누르면 녹음, 다시 누르면 멈추고 **브라우저 안에서** Whisper(transformers.js `@huggingface/transformers` 4.3.1)로 글자로 바꿔 입력창에 붙임. 서버로는 글자만 감 (음성은 안 나감).

- 모델 (⚙): Whisper base(빠름) / small / **large-v3-turbo(기본, 정확)**. WebGPU면 GPU로, 없으면 WASM(CPU)으로. 장치에 맞춰 받는 파일을 고름 (turbo: WebGPU f16이면 q4f16 약 564MB). 처음 한 번 Hugging Face에서 받고 브라우저 캐시에 둠. "미리 받기"로 먼저 받아 둘 수 있고, 녹음하는 동안에도 받음
- 언어: 기본은 브라우저 언어 (ko-KR → 한국어). "자동"도 있지만 실측으로 한국어 음성을 영어 문장으로 내놓아서 비추천
- "인식되면 바로 보내기": 입력창을 거치지 않고 바로 세션에 보냄
- 30초 넘는 녹음은 30초씩 겹쳐 잘라 인식, 5분이면 알아서 멈춤
- 추론은 Web Worker(`web/src/asr/worker.ts`)에서. 화면 번들은 그대로 (워커 약 550KB + onnxruntime WASM 약 27MB는 처음 쓸 때만 받음)
- 마이크는 보안 컨텍스트에서만 열림: `127.0.0.1`/`localhost`나 https. `--host 0.0.0.0`으로 열어 다른 기기에서 http로 들어오면 버튼이 비활성
- 실측 (이 맥 Chrome, WebGPU f16, macOS `say`로 만든 음성): turbo 한국어 3.7초 → 약 1.0초 "안녕하세요. 오늘 회의 자료를 정리해서 요약해 주세요." (그대로), 영어 2.8초 → 0.95초 (그대로). base는 0.86초, 한국어에 "?"·띄어쓰기 차이 정도. 실제 마이크 녹음 경로(권한 창)는 자동 테스트로 못 해봄

### 드라이브 / 첨부

사람과 세션이 같이 쓰는 파일 공간 ([웹드라이브](drive.md)). 위쪽 "드라이브"(`/#drive`)는 전체, 세션 상세의 "드라이브" 탭(tmux·SDK 둘 다)은 그 세션 폴더(`/sessions/<이름>`)에서 시작.

- 올리기(버튼·끌어 놓기, 진행률), 폴더 만들기, 글 파일 만들기·편집(⌘/Ctrl+S), 이름 바꾸기(`/`로 시작하면 옮기기), 지우기(한 번 더 확인), 받기, 드라이브 경로·로컬 경로 복사. 파일 이름을 누르면 새 탭에서 바로 보기.
- 세션이 `drive_upload`/`drive_write` 하면 `/ws/events` 알림으로 보고 있는 폴더가 바로 갱신.
- 대화 탭·보내기 탭 입력창: "📎 파일"(또는 끌어 놓기·붙여넣기)로 고르면 바로 `/sessions/<이름>/attachments/`에 올라가고 칩으로 보임. "드라이브에서"로 있는 파일을 고를 수도 있음. 보내면 서버가 지시 뒤에 드라이브 경로 + 로컬 경로 안내를 붙임. 첨부만 보내도 됨.

### 채널

- 받은 이벤트마다: 이벤트 ID, 본문, 첨부(크기, 저장 실패), 전달(대기/전달/실패 + 사유), 답장(답장/자동 답장, 실패 사유, 첨부 이름).
- "직접 답장": 텍스트 + 파일(최대 10개, 각 10MB) + 보낸 세션(기록용, 자동 답장 중복 방지에도 씀). 원래 메시지에 답장으로 감.
- local 채널 넣기: 채널·작성자·내용 + 봇 멘션 + 첨부파일. 첨부 없으면 REST로 넣고 매칭된 세션을 바로 보여줌, 첨부가 있으면 `/ws/channel`로 넣고 결과는 목록에서 확인.
- local 채널 답장의 첨부파일은 DB에 본문이 없어서, 화면이 열려 있는 동안 `/ws/channel`로 받은 것만 "⬇ 파일 이름" 링크로 내려받을 수 있음.

### 토큰

서버를 `CARDINAL_TOKEN`으로 띄웠으면 주소에 `?token=…`을 붙여 한 번 열거나(이 브라우저에 저장하고 주소창에서 지움) 상단 "토큰" 버튼으로 입력. API가 401을 주면 입력 창이 자동으로 뜸. REST는 `Authorization: Bearer`, 웹소켓은 쿼리 `?token=`. 정적 파일은 토큰 없이 받음 (비밀 없음).

### 주소로 화면 고르기

`/#s=<세션 이름>` (세션 상세), `/#channel` (채널), `/#drive` (드라이브). 지금 화면이 주소 해시에 반영돼서 새로고침·북마크해도 그대로.

## 파일

| 파일 | |
| --- | --- |
| `web/src/api.ts` | API 클라이언트, 토큰, 웹소켓 주소, 답장 멀티파트, 첨부 base64, 16KB 한도 |
| `web/src/types.ts` | 서버 응답 타입 |
| `web/src/hooks.ts` | 재연결되는 JSON 웹소켓 구독(`useJsonSocket`), 보내기도 하는 것(`useSocket`, `/ws/sdk`), 주기 실행 |
| `web/src/App.tsx` | 전체 구성, 세션 목록 실시간 갱신, 토큰, 주소 해시 |
| `web/src/components/SessionList.tsx` | 세션 목록 |
| `web/src/components/CreateSession.tsx` | 새 세션 (백엔드 고르기) |
| `web/src/components/SdkOptionsFields.tsx` | SDK 옵션 폼 (새 세션, 설정 탭에서 같이 씀), 폼 ↔ 옵션 변환·검사 |
| `web/src/components/SdkPanels.tsx` | SDK: 대화(실시간, 질문/권한 카드) / MCP / 설정 |
| `web/src/components/MicInput.tsx`, `web/src/asr/*` | 음성 입력: 마이크 녹음, Whisper 워커, 모델·언어 설정 |
| `web/src/components/SessionView.tsx` | 세션 상세, 세션 정보, 탭 (백엔드마다 다름, 터미널은 필요할 때만 불러옴), 중단·다시 시작 |
| `web/src/components/SessionPanels.tsx` | 화면 / 보내기 / 결과 / 훅 이벤트 / 라우트 |
| `web/src/components/TerminalView.tsx` | xterm.js + `/ws/term` |
| `web/src/components/DrivePanel.tsx`, `AttachBar.tsx` | 웹드라이브 탐색기·편집기, 요청 첨부 |
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

SDK 세션 화면도 실제 Chrome으로 확인 (질문 답하기, 스트리밍 + 중단, MCP 추가·상태, 가려진 옵션으로 다시 시작, 서버 재시작 뒤 이어서, 권한 거부/허용, 같은 화면에서 tmux 세션). 자세한 건 [SDK 모드 → 확인한 것](sdk-mode.md#확인한-것).

## 알아둘 것

- 터미널의 한글은 칸 2개를 차지함. 브라우저에 칸 폭에 맞는 한글 고정폭 폰트(D2Coding 등)가 없으면 자간이 벌어져 보임.
- 첫 로딩은 약 290KB(gzip 89KB), 터미널 탭(xterm)은 열 때 약 330KB(gzip 84KB)를 더 받음. SDK 세션만 쓰면 xterm은 안 받음.
- 종료, 살아있는 세션의 다시 시작은 브라우저 확인 창(`confirm`)을 띄움.
- 컨텍스트 사용량의 항목 색은 Claude Code 테마 이름(`promptBorder` 등)으로 와서 CSS로 못 씀 → 화면 쪽 색을 순서대로 씀. "Free space"와 지연 로드 항목은 막대에서 뺌.
- 서브 에이전트의 메시지(`parent_tool_use_id`가 있는 것)는 대화 탭에 안 보임 (메인 에이전트만).
- 라우트 켜기/끄기(`enabled`)는 DB에 칼럼만 있고 서버 API가 없어서 화면에도 없음 (추가·삭제로 대신).
