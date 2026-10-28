# 웹드라이브

[English](drive.en.md) · 관련: [서버](server.md), [카디널 MCP](mcp.md), [웹 UI](web-ui.md)

사람(웹 UI)과 세션(모델)이 **같이 쓰는 파일 공간**. 결과 파일을 주고받거나, 요청에 파일을 붙이거나, 세션끼리 파일을 넘길 때 씀. 서버가 떠 있을 때만 있음 (서버 기능).

## 자리

```
$CARDINAL_HOME/drive          (CARDINAL_DRIVE 로 바꿈, 기본 ~/.cardinal/drive)
├ shared/                     다 같이 쓰는 곳
└ sessions/<세션 이름>/        세션마다 하나
    └ attachments/            사람이 요청에 붙인 파일
```

- **규칙: 모든 세션은 자기 드라이브 폴더가 있음.** 서버로 만들면 만들 때(첫 지시 전에) 생기고, CLI로 직접 만든 tmux 세션도 수집되면 생김. 서버가 뜰 때도 한 번 맞춤.
- 폴더 이름은 세션 이름. 이름을 다시 쓰면(`kill --purge` 후 같은 이름) 같은 폴더를 이어 씀. 세션을 지워도 드라이브 폴더는 안 지움 (사람 파일일 수 있어서).
- 드라이브 경로는 항상 `/`로 시작하는 드라이브 기준 경로 (`/shared/a.txt`). 세션 도구에서 `/` 없이 쓰면 **그 세션 폴더 기준** (`result.txt` → `/sessions/<나>/result.txt`).
- 루트, `/shared`, `/sessions`, `/sessions/<이름>` 자체는 지우기·옮기기 안 됨 (안의 것은 됨).
- 드라이브 밖으로는 못 나감: `..`로 루트 위로 가는 경로, 드라이브 밖을 가리키는 심볼릭 링크는 거부 (목록에서도 빠짐).

## 세션이 읽게 하기

세션이 드라이브 파일을 작업 폴더 밖이어도 권한을 묻지 않고 바로 읽게, 드라이브를 추가 폴더로 붙임.

- SDK 세션: `add_dirs`에 드라이브 폴더를 늘 붙임
- tmux 세션(서버로 만든 것): claude 인자에 `--add-dir=<드라이브>`. `--add-dir`은 값을 여러 개 받는 옵션이라 `=`로 붙여야 뒤에 오는 첫 지시를 폴더로 안 먹음 (실측 확인)

프롬프트(SDK `COMMON_PROMPT`, tmux `MCP_COMMON_PROMPT`)와 MCP 안내문에 "네 폴더는 /sessions/<이름>, 공용은 /shared, 도구는 이렇게"를 넣어 둠.

## 사람 쪽 (REST)

| 메서드 | 경로 | |
| --- | --- | --- |
| GET | `/api/drive?path=/` | 폴더 내용. 항목: `name, path, type(file/dir), size, mtime, content_type, local_path` |
| GET | `/api/drive/file?path=[&download=true]` | 파일 받기. 기본은 브라우저에서 바로 보기(inline), `download`면 내려받기 |
| GET | `/api/drive/text?path=` | UTF-8 글 파일 내용 (2MB까지, 바이너리면 400) |
| PUT | `/api/drive/text` | `{path, content, overwrite=true}` 글 파일 만들기/고치기. 폴더는 알아서 만듦. `overwrite=false`면 새 파일만 |
| POST | `/api/drive/upload` | 멀티파트 `path`(폴더, 기본 `/shared`), `files[]`, `overwrite`. 같은 이름이면 `a (1).txt`로. 하나당 한도 `CARDINAL_DRIVE_MAX_MB`(기본 1024), 넘으면 413 |
| POST | `/api/drive/mkdir` | `{path}` |
| POST | `/api/drive/move` | `{src, dst, overwrite}` 옮기기/이름 바꾸기. `dst`가 있는 폴더면 그 안으로 |
| DELETE | `/api/drive?path=[&recursive=true]` | 지우기. 비어 있지 않은 폴더는 `recursive` 필요 |
| POST | `/api/sessions/<이름>/attachments` | 요청에 붙일 파일을 `/sessions/<이름>/attachments/`에 저장. 돌려받은 `path`를 send의 `attachments`로 |

- 올리기는 임시 파일(`.cardinal-up-…`)에 조금씩 쓰고 다 받으면 이름을 바꿈. 한도를 넘거나 끊기면 임시 파일을 지움. 목록에는 임시 파일이 안 보임.
- 바뀌면 `/ws/events`로 `{"type":"drive","path":<바뀐 폴더>}`를 뿌림. 웹 UI가 그 폴더를 보고 있으면 다시 읽음 (세션이 올린 것도 바로 보임).

## 요청에 파일 붙이기

`POST /api/sessions/<이름>/send`, `/ws/sdk/<이름>`의 `send`에 `attachments: [드라이브 경로…]`를 주면 서버가 지시 뒤에 안내를 붙여서 보냄 (tmux, SDK 같은 글):

```
첨부한 메모에 적힌 코드명만 한 단어로 답해.

[첨부 1개 — 카디널 웹드라이브. 로컬 경로를 바로 읽거나 mcp__cardinal__drive_load 로 작업 폴더에 복사]
- /sessions/dw1/attachments/memo.txt (text/plain, 0KB) → /Users/…/.cardinal/drive/sessions/dw1/attachments/memo.txt
```

- 지시가 비어 있어도 첨부만 보낼 수 있음.
- 없는 드라이브 경로면 400 (보내기 전에 막음).
- 웹 UI: 대화 탭·보내기 탭 입력창의 "📎 파일"(또는 끌어 놓기·붙여넣기)로 고르면 바로 세션 첨부 폴더에 올라가고, "드라이브에서"로 이미 있는 파일을 고를 수도 있음.
- 마스터 도구 `session_new`, `session_send`도 `attachments`를 받음 (워커에게 파일 넘기기).

## 세션 쪽 (카디널 MCP 도구, 워커·마스터 둘 다)

| 도구 | 하는 일 |
| --- | --- |
| `drive_list(path?)` | 폴더 내용. 안 주면 내 폴더. 항목마다 `local_path` |
| `drive_read(path)` | 글 파일 읽기 (UTF-8, 2MB까지) |
| `drive_write(path, content, overwrite=true)` | 글 파일 만들기/고치기 (내용 전체) |
| `drive_move(src, dst, overwrite?)` | 드라이브 안에서 옮기기/이름 바꾸기 |
| `drive_delete(path, recursive?)` | 지우기 |
| `drive_upload(src, path?, keep_source?, overwrite?)` | **로컬 → 드라이브로 옮김** (기본 이동, `keep_source`면 복사). `src` 상대 경로는 작업 폴더 기준. `path`를 안 주면 내 폴더에 같은 이름 |
| `drive_load(path, dest?, overwrite?)` | 드라이브 → 로컬로 복사 (드라이브 쪽은 그대로). `dest`를 안 주면 작업 폴더에 같은 이름 |

사람과 세션이 같은 CRUD를 함: 만들기(올리기 / `drive_write`·`drive_upload`), 읽기(목록·받기·편집기 / `drive_list`·`drive_read`·`drive_load`), 고치기(편집기·이름 / `drive_write`·`drive_move`), 지우기(✕ / `drive_delete`).

파일 작업은 스레드에서 해서(`asyncio.to_thread`) 큰 파일을 옮겨도 서버가 안 멈춤. 그 스레드에서 나온 변경 알림은 서버 루프로 넘겨서 뿌림 (처음엔 이걸 안 해서 `drive_upload`가 파일은 옮기고 "no running event loop" 오류를 냈음).

## 웹 UI

- 위쪽 "드라이브" (`/#drive`): 드라이브 전체. 경로 막대, 올리기(버튼·끌어 놓기, 진행률), 폴더 만들기, 글 파일 만들기, 편집(글 파일, ⌘/Ctrl+S 저장), 이름 바꾸기(새 이름 또는 `/`로 시작하는 경로면 옮기기), 지우기(한 번 더 확인), 받기, 드라이브 경로·로컬 경로 복사. 파일 이름을 누르면 새 탭에서 바로 보기.
- 세션 상세 "드라이브" 탭 (tmux, SDK 둘 다): 같은 화면을 그 세션 폴더에서 시작.
- 대화·보내기 탭 첨부: 위 "요청에 파일 붙이기".

## 파일

| 파일 | |
| --- | --- |
| `server/cardinal_server/drive.py` | 경로 정리·막기, 목록, 올리기(스트림), 글 읽기/쓰기, 옮기기, 지우기, 로컬 ↔ 드라이브, 첨부 안내 |
| `server/cardinal_server/app.py` | `/api/drive*`, `/api/sessions/<이름>/attachments`, 세션 폴더 맞추기, 변경 알림 |
| `server/cardinal_server/sessions.py` | 세션 만들 때 폴더, tmux `--add-dir=`, send의 `attachments` |
| `server/cardinal_server/mcp_server.py` | `drive_*` 도구, `session_new/send`의 `attachments` |
| `web/src/components/DrivePanel.tsx` | 드라이브 탐색기 + 편집기 + 고르기 모드 |
| `web/src/components/AttachBar.tsx` | 요청 첨부 (올리기, 드라이브에서 고르기, 끌어 놓기·붙여넣기) |

## 확인한 것

scratch 서버(7889, `--sdk`), haiku 세션으로:

- REST: 목록, 같은 이름 두 번 올리기 → `t1 (1).txt`, inline/attachment 받기, 폴더 만들기, 옮기기, 폴더를 자기 안으로 옮기기 거부, `/../etc`·`../..`·밖을 가리키는 링크 거부, `/shared` 지우기 거부, 비어 있지 않은 폴더는 `recursive` 필요, 한도 1MB로 띄워 2MB 올리기 → 413 + 임시 파일 안 남음, 글 파일 만들기/덮어쓰기 막기/읽기, 바이너리 읽기 → 400
- SDK 세션: 첨부 붙여 보내기 → 메모 내용으로 답함. `drive_upload`(기본 이동 → 작업 폴더에서 사라짐), `drive_load`, `drive_write → drive_read → drive_move → drive_delete → drive_list` 순서대로 다 됨
- tmux 세션: `--add-dir=` 붙여도 첫 지시(`--prompt`) 그대로 전달, 첨부를 권한 질문 없이 읽음, `drive_upload` 됨
- 웹 UI(Chrome): 드라이브 화면, 폴더 들어가기, 편집기 저장, 대화 탭에서 파일 붙여 보내기(세션이 읽고 답함), 세션이 `drive_write` 하자 열린 드라이브 탭에 바로 나타남

## 알아둘 것

- 사람용 REST는 서버 토큰(`CARDINAL_TOKEN`)으로만 막힘. 드라이브는 한 사람(또는 한 팀)이 같이 쓰는 공간이라 세션마다 권한을 나누지 않음: 어느 세션이든 드라이브 전체를 읽고 씀.
- **워커끼리 서로의 폴더를 읽고 씀** (일부러 그렇게 둠): w1이 `drive_write("/sessions/w2/x.txt")`로 w2 폴더에 쓰고, w2가 `drive_read("x.txt")`로 읽고, `drive_move`로 w1 폴더에 돌려놓는 것까지 확인. 프롬프트·MCP 안내문에도 "다른 세션 폴더(/sessions/<그 이름>)도 읽고 쓸 수 있음"을 적어 둠. 워커끼리 일을 맡길 때([카디널 MCP](mcp.md) 워커 규칙) 결과 파일을 주고받는 자리.
- 채널(디스코드 등) 첨부는 아직 예전처럼 `~/.cardinal/inbox/<이벤트>`에 저장됨 (드라이브로 안 감).
- 텍스트 편집은 2MB까지. 더 큰 파일은 받기/올리기로.
