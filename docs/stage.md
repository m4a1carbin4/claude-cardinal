# 스테이지 (캐릭터로 관리자와 대화)

[English](stage.en.md) · 관련: [관리자 세션](admin-session.md), [SDK 모드](sdk-mode.md)

`/stage` 페이지. 화면 가득 캐릭터(아로나)와 배경이 나오고, 아래 입력창에 쓴 말이 **관리자 세션에 바로 감**. 관리자 답은 캐릭터 말풍선으로 나오고 문단마다 표정이 바뀜. 캐릭터 모듈은 BA-REA(Character Stage)에서 가져옴.

메인 화면 위쪽 `스테이지` 칩을 누르면 새 탭으로 열림 (관리자 세션이 있을 때만 보임).

## 리소스 준비 (저장소에 없음)

캐릭터·배경은 블루 아카이브 클라이언트에서 뽑은 파일이라 **저장소에 넣지 않고 재배포도 안 됨**. 서버가 `CARDINAL_STAGE_ASSETS`(기본 `~/.cardinal/stage-assets`) 폴더에서 `/stage-assets/…`로 내려줌.

```
~/.cardinal/stage-assets/
  arona_spr/arona_spr.skel, arona_spr.atlas, arona_spr.png   # Spine 4.2
  bg/BG_AronaRoom.jpg
```

BA-REA 의 `public/game-assets`와 같은 구조라 링크만 걸면 됨:

```
ln -s ~/BA-REA/public/game-assets ~/.cardinal/stage-assets
```

없으면 캐릭터 대신 "캐릭터를 못 불러옴" 안내가 나오고, 대화는 그대로 됨.

`/stage-assets`는 API 와 같은 토큰(`CARDINAL_TOKEN`)을 요구함. spine 로더가 헤더를 못 붙여서 스테이지 페이지가 `cardinal_token` 쿠키(경로 `/stage-assets`만)를 심어서 보냄.

## 흐름

1. 페이지가 `/api/health`에서 관리자 이름을 받고 `/ws/sdk/<관리자>`에 붙음
2. 입력한 말은 `[스테이지] <말>`로 보냄. 관리자 프롬프트에 이 표시가 붙은 말엔 짧게, 마크다운 없이, `[emo:NN]` 표정을 붙여 답하라고 적혀 있음
3. 서버가 턴이 시작될 때 `turn_start`(`origin`, `prompt`)를 보냄 → 페이지가 지금 턴이 스테이지에서 온 건지 앎
4. 스테이지 턴의 답(`AssistantMessage`의 글)만 말풍선으로 읽음. 다른 곳(웹 대화 탭, 채널, MCP)에서 시킨 일의 답은 왼쪽 기록에만 남음. `다른 곳 대화도 읽기`를 켜면 그것도 읽음
5. 답 → 대사: 코드 블록은 "(코드는 대화 탭에서)"로 바꾸고, 표·가로줄은 빼고, 마크다운 기호를 지우고, 문단마다 한 덩어리(160자 넘으면 문장 끝에서 자름). `[emo:NN]`은 그 문단부터 표정 번호

그 밖에:

- 🎤 음성 입력: 아래 [음성 입력](#음성-입력)
- 🔊 대사를 소리 내어 읽기: 아래 [목소리](#목소리-tts)
- `중단`: 말풍선·음성을 멈추고 관리자 턴도 중단
- 관리자가 질문(권한·AskUserQuestion)을 하면 기록에 안내가 나옴. 답은 메인 화면 대화 탭에서
- 캐릭터 만지기(머리 쓰다듬기, 헤일로·몸 누르기)는 페이지 안에서만 반응하고 관리자에게는 안 보냄 (토큰 아끼려고)
- `H` 또는 오른쪽 위 버튼으로 왼쪽 패널 숨기기
- 개발자 도구에서 `stage.agent.play({ text, emotion })`, `renderer.setExpression('05')`로 직접 만져 볼 수 있음

## 음성 입력

글자로 바꾸는 건 메인 화면 대화 탭과 같은 브라우저 안 Whisper (음성은 서버로 안 감, 글자만 감). 모델·언어·`인식되면 바로 보내기`는 대화 탭과 같이 씀(`localStorage` `cardinal.asr`). 듣는 방식은 ⚙ 에서 셋 중 고름 (`cardinal.stage.voice`, 이 브라우저에만):

| 방식 | 하는 일 | 보내기 |
| --- | --- | --- |
| 버튼 | 🎤 누르면 녹음, 다시 누르면 끝 (대화 탭과 같음) | `인식되면 바로 보내기` 따름, 끄면 입력창에 붙임 |
| 누르는 동안 | 🎤 나 `Space` 를 누르고 있는 동안만 들음 | 떼면 바로 |
| 계속 듣기 | 켜 두면 말할 때마다 알아서 끊어서 보냄. `M` 으로 켜고 끄기 | 한 마디마다 바로 |

- 누르는 동안·계속 듣기 버튼엔 마이크 소리 크기 막대가 나옴. 입력창에 쓰는 중엔 `Space`·`M` 을 안 받음
- 누르는 동안: 처음 누를 때 마이크를 열고 1분 안 쓰면 닫음. 열려 있으면 누르기 바로 전 0.32초도 붙여서 첫 소리가 안 잘림
- 계속 듣기: 켜져 있는 동안 마이크가 계속 열려 있음. 말 끝(조용한 길이, 기본 0.8초)과 민감도를 ⚙ 에서 조절. 소음에 Whisper 가 지어내는 흔한 문장("감사합니다", "시청해 주셔서 감사합니다", "Thank you" 등)만 나오면 버림
- 마디를 글자로 바꾸는 동안에도 계속 들음 (바꾸기는 차례로)
- 호출어(계속 듣기, ⚙ `이름을 부를 때만 보내기`): 이름(기본 `아로나`)으로 시작하는 말만 이름을 떼고 보냄 ("아로나, 오늘 날씨 어때?" → "오늘 날씨 어때?"). 버튼에 `💤 “아로나” 대기`
  - 이름만 부르면 관리자에겐 안 보내고 아로나가 "네, 선생님! 말씀하세요." 같은 말로 대답, 이어서 하는 말은 이름 없이 받음
  - 스테이지에서 보낸 말을 관리자가 처리하는 동안과 답이 끝나고 몇 초(`답 뒤 이름 없이`, 기본 8초)는 이름 없이 받음
  - Whisper 가 이름을 조금 다르게 적어도 받음: 한글을 자모로 풀어 한 글자 안팎 차이까지 ("아론아", "아로나야", "헤이 아로나", "아로나 씨"). `web/src/stage-page/wake.ts`

말 끝 판단은 [ming-voice](https://github.com/JMS1717/ming-voice)를 보고 만듦. 차이:

| | ming-voice | 스테이지 |
| --- | --- | --- |
| 소리 받기 | AudioWorklet 에서 16kHz 로 줄여 512 샘플(32ms)씩 서버로 | 같은 방식, 브라우저 안에서만 씀 (`web/src/asr/listen.ts`) |
| 말소리 판단 | 서버 Silero VAD (+ 소리 크기로 멈춤 시점 앞당김) | 소리 크기: 배경 소음(처음 0.5초 + 조용할 때 따라감) 대비 몇 배 크면 말, 말하던 크기보다 20dB 작으면 조용 |
| 말 끝 | 멈춤 0.5초, 1초 안 되는 말엔 0.25초 더, Smart Turn 모델이 끝났다/아니다 판단 | 멈춤(기본 0.8초, 조절), 짧은 말엔 0.25초 더. 판단 모델 없음 |
| 앞부분 | 0.32초 pre-roll | 같음 |
| 끼어들기·에코 | 답하는 소리가 마이크로 다시 들어오는 걸 걸러 냄 | 말하기 시작하면 캐릭터 음성을 끊음. 에코는 브라우저 echoCancellation 에만 맡김 ([목소리](#목소리-tts)) |
| 방식 | 핸즈프리 / 호출어 / 누르는 동안(Space) | 계속 듣기(+호출어) / 누르는 동안(Space) / 버튼 |
| 호출어 | 말하는 동안 앞 몇 초를 미리 글자로 바꿔 이름 확인, 이름만 부르면 알림음, 답 뒤 8초는 이름 없이 | 마디가 끝난 뒤 글자로 바꿔 확인, 이름만 부르면 아로나가 대답, 보낸 턴 동안·답 뒤 8초(조절)는 이름 없이 |

## 목소리 (TTS)

관리자 답의 대사를 캐릭터가 **소리 내어 읽음**. 모델은 [ZONOS3-Mini](https://huggingface.co/Zyphra/ZONOS3-Mini), 대사 줄이 오는 대로 스트리밍으로 만들어서 첫 소리가 바로(호스트 CPU 기준 ~0.15–0.3초) 나오고, 소리 크기로 입 모양을 움직임. 왼쪽 패널 `🔊` 줄을 누르면 설정이 펼쳐짐.

### 엔진 둘 (같은 v2 API)

| 엔진 | 어디서 만드나 | 경로 |
| --- | --- | --- |
| 기기 | 이 브라우저의 GPU (WebGPU). upstream `servers/web` 의 `engine.js` 를 웹 워커에서 돌림 (`localFetch` 가 v2 API 를 흉내 냄). 처음엔 모델 ~1GB(backbone + zac)를 받고 브라우저 Cache Storage 에 둠 | 엔진 파일 `/stage-tts/engine/*`, 모델 조각 `/stage-tts/models/*` |
| 호스트 | 카디널 서버 컴퓨터의 `zonos3-server` (CPU ggml). 카디널 서버가 받는 조각을 쌓지 않고 바로 흘려보냄 | `/api/stage/tts/v2/{generate,speakers,capabilities,controls,health}` → `CARDINAL_STAGE_TTS_URL` |

둘 다 `/v2/generate` 를 `stream: true, format: "pcm"`(float32 44.1kHz 모노)로 부르고, 받는 쪽 코드(`tts/backend.ts` 의 `streamGenerate`, `tts/player.ts`)는 같이 씀.

⚙ 고르기 (`localStorage` `cardinal.stage.tts`, 이 브라우저에만):

- **자동**(기본): WebGPU 가 있고 어댑터가 소프트웨어가 아니며 버퍼 한도가 넉넉하면 기기 엔진을 뒤에서 불러옴. 불러오는 동안은 호스트로 말함. 다 불러오면 시험 문장 하나를 만들어 RTF(생성 시간 / 소리 길이)가 0.6 이하면 기기로, 아니면 호스트로 (호스트가 꺼져 있으면 느려도 기기)
- **기기** / **호스트**: 그것만. **끔**: 말풍선만
- 패널 줄에 지금 엔진, 캐릭터 목소리, 마지막 줄의 첫 소리까지 시간(TTFA)·RTF 가 보이고, 펼치면 이유·기기 불러오기 진행·생성 대기 줄 수·오류가 보임

### 대사 → 소리

1. 답이 와서 대사 줄로 나뉘면(`lines.ts`) 줄마다 `tts.line(text)` 가 바로 PCM 스트림을 돌려줌 → 감독(`AgentDirector`) 큐에 `audio` 로 들어감
2. 생성은 뒤에서 차례로 한 줄씩: 앞 줄이 재생되는 동안 다음 줄을 미리 만듦 (`tts/manager.ts`)
3. 재생(`tts/player.ts`)은 조각이 오는 대로 한 AudioContext 시간축에 이어 붙여 예약 (빈틈 없음, 첫 조각만 0.12초(기기 0.2초) 늦게). analyser 의 RMS 를 감독이 33ms 마다 읽어 입을 엶/닫음. 줄과 줄 사이는 0.25초
4. 끊기: `중단`, 스테이지에서 말을 보낼 때, 스테이지 턴이 시작될 때, 사람이 말하기 시작할 때(🎤 녹음 시작·누르는 동안·계속 듣기에서 말소리 시작. 호출어 대기 중엔 이름을 불러야) → 재생 중인 줄·기다리는 줄·생성 중인 요청까지 멈춤 (호스트면 카디널 → zonos3-server 연결도 끊어서 생성도 멈춤)
5. 글자·기호만 있는 줄(이모지 등)은 안 읽음. 생성이 실패하면 그 줄은 말풍선만

계속 듣기 중엔 캐릭터 소리가 마이크로 들어올 수 있음. 마이크는 브라우저 에코 제거(`echoCancellation`)를 켜고 열어서 보통은 걸러지지만, 스피커 소리가 크면 캐릭터가 자기 말에 끊길 수 있음 (그럴 땐 호출어를 켜거나 이어폰).

### 목소리 디자인 · 저장

`🎛 목소리 디자인…` 창 (지금 엔진으로 미리 들음):

- **기본 목소리**: 엔진의 기본 목소리 목록(한국어 Seoyeon·Minjun 등 27~30개), ▶ 로 원본 듣기
- **섞기**: 두 목소리를 화자 임베딩 구면 보간(slerp, `speaker_blend_*`)으로. 임베딩 모드로만 말함
- **내 음성**: 파일 올리기나 녹음(30초까지). 브라우저에서 모노 44.1kHz wav 로 바꾸고 작으면 키움. 엔진에 올려(`POST /v2/speakers`) 화자로 바꿈
- **조절**: 언어, 화자 방식(reference: 참고 음성을 이어 말하듯 / embedding: 임베딩만), 말 빠르기·크기(`condition_values`, 체크포인트의 condition rows: `speaking_rate` UTF-8 바이트/초, `loudness` LUFS), temperature, speaker CFG, seed. 스티어링 번들(`steer.gguf`)이 있는 엔진이면 `controls` 슬라이더도 나옴 (지금 받은 모델엔 둘 다 없음)
- **캐릭터가 말하기**: 시험 대사를 캐릭터가 입 모양까지 그대로 말함 + TTFA·RTF·seed
- **저장**: 카디널 서버 목소리 저장소로. `캐릭터 목소리로` 를 켜 두면 바로 스테이지 캐릭터 목소리가 됨. 저장한 목소리는 같은 창에서 캐릭터로·고치기·지우기, 패널의 `캐릭터 목소리` 에서도 고름 (서버에 저장이라 어느 브라우저에서나 같음)

저장소 (`CARDINAL_STAGE_TTS_VOICES`, 기본 `~/.cardinal/stage-tts/voices/`):

```
voices/<id>/voice.json     # 레시피: name, source({type: default, label} | {type: blend, a, b, t} | {type: clip}),
                           #   language, speaker_mode, condition_values, controls, params, test_text, embedding(192개 숫자)
voices/<id>/reference.wav  # 내 음성일 때 참고 음성
voices/active.json         # 캐릭터 목소리 id
```

저장할 때 늘 화자 임베딩을 같이 넣음 (기본 목소리는 `GET /v2/speakers/{id}/embedding`, 섞기는 브라우저에서 slerp, 내 음성은 엔진이 만든 것). 쓸 때 엔진마다:

| 목소리 | 호스트 | 기기 |
| --- | --- | --- |
| 기본 | 같은 이름의 기본 목소리 id (두 엔진이 같은 id) | 같음 |
| 섞기 | 임베딩을 `.npy` 로 올림 → 임베딩 모드 | 같음 |
| 내 음성 | `reference.wav` 를 올림 (reference 모드 됨) | 임베딩을 `.npy` 로 올림 (음성 → 화자 변환 모델 ~2.7GB 를 안 받게) |

올린 id 는 브라우저가 기억하고, 엔진이 다시 켜져서 모르는 id 라고 하면(400) 다시 올리고 한 번 더 함. zonos3-server 는 올린 목소리를 `X-TTS-Session-ID` 별로 두는데 카디널이 `cardinal-stage` 로 고정해서 넘김.

### 준비

**호스트 엔진** (CPU, 4코어 이상 권장. i5-13600KF 에서 RTF ~0.25, 동시 4줄까지 실시간):

```bash
# ZONOS3-Mini 저장소의 servers/ggml 빌드와 GGUF (backbone-ptq.gguf, zac-keep2.gguf, spk-encoder.gguf)가 있다고 치고
cd ZONOS3-Mini/servers/ggml
./build/zonos3-server gguf/backbone-ptq.gguf --cpu --zac-cpu --host 127.0.0.1 --port 1919 --batch 4 \
  --tts-default-voices-dir ../../assets/default_voices --spk-encoder gguf/spk-encoder.gguf
```

카디널이 띄우고 끄게 하려면 `CARDINAL_STAGE_TTS_CMD` 에 위 명령, `CARDINAL_STAGE_TTS_CWD` 에 작업 폴더. 서버가 시작할 때(그리고 요청이 왔는데 답이 없을 때) 그 주소가 답하지 않으면 띄우고, 카디널이 꺼질 때 같이 끔. 로그는 `~/.cardinal/stage-tts/zonos3-server.log`. 이미 그 주소에서 답하는 서버가 있으면 그걸 씀.

**기기 엔진** (WebGPU, https 또는 localhost 에서만):

```bash
# 엔진 빌드 (ZONOS3-Mini 저장소)
pnpm install && pnpm --dir servers/web build
mkdir -p ~/.cardinal/stage-tts && cp -r servers/web/dist ~/.cardinal/stage-tts/engine
# 모델 조각 (HF Zyphra/ZONOS3-Mini 의 web/). 내 음성을 기기에서 화자로 바꾸려면 encoder·teacher 도
hf download Zyphra/ZONOS3-Mini --include 'web/backbone/*' 'web/zac/*' 'web/voices/*' 'web/companions/*' 'web/laci/*' 'web/spk/*' \
  --local-dir ~/.cardinal/stage-tts/hf
ln -s hf/web ~/.cardinal/stage-tts/models
```

`/stage-tts/*` 도 API 토큰을 요구함. 워커가 헤더를 못 붙여서 스테이지 페이지가 `cardinal_token` 쿠키(경로 `/stage-tts`)를 심음.

설정 (환경변수):

| 변수 | 기본 | |
| --- | --- | --- |
| `CARDINAL_STAGE_TTS_URL` | `http://127.0.0.1:1919` | 호스트 zonos3-server. 빈 값이면 호스트 끔 |
| `CARDINAL_STAGE_TTS_CMD` | 없음 | 있으면 카디널이 zonos3-server 를 띄우고 끔 |
| `CARDINAL_STAGE_TTS_CWD` | 없음 | 위 명령의 작업 폴더 |
| `CARDINAL_STAGE_TTS_ENGINE` | `~/.cardinal/stage-tts/engine` | `engine.js`, `worker.js`, `codec-worker.js` |
| `CARDINAL_STAGE_TTS_MODELS` | `~/.cardinal/stage-tts/models` | 모델 조각 (`backbone/`, `zac/`, `voices/` …) |
| `CARDINAL_STAGE_TTS_VOICES` | `~/.cardinal/stage-tts/voices` | 저장한 목소리 |

`GET /api/stage/tts/status` 가 호스트가 답하는지·카디널이 띄웠는지, 기기 엔진 파일·모델이 있는지 알려줌.

시험용: `localStorage` `cardinal.stage.tts.forceDevice=1` 이면 소프트웨어 WebGPU(SwiftShader)여도 기기 엔진을 씀 (GPU 없는 헤드리스에서 연결 확인용, RTF ~70 이라 실제로는 못 씀). 개발자 도구에서 `tts.state`, `tts.setMode('host')`.

## 표정 번호

직접 하나씩 띄워서 붙인 이름. 관리자 프롬프트에도 같은 목록이 있음.

| 번호 | 표정 | 번호 | 표정 |
| --- | --- | --- | --- |
| 00 | 기본 미소 | 17 | 어지러움 (소용돌이 눈) |
| 01 | 미소 (깜빡임) | 18 | 부끄러워 외침 (> <, 홍조) |
| 02 | 놀람 (입 동그랗게) | 19 | 부끄러운 당황 |
| 03 | 눈웃음 (기쁨) | 20 | 밝게 말하기 |
| 04 | 당황 (땀) | 21 | 설렘 (반짝 눈, 하트) |
| 05 | 삐짐 (주황 헤일로) | 22 | 결의 (반짝 눈) |
| 06 | 울먹 | 23 | 졸음 (침) |
| 07 | 곤란 (이 악묾) | 24 | 하품 |
| 08 | 신나서 말하기 | 25 | 깨달음 (반짝 눈, 놀람) |
| 09 | 난감한 웃음 | 26 | 시큰둥 |
| 10 | 한숨 (눈 감고) | 27 | 투덜 |
| 11 | 아주 기쁨 (하트 헤일로) | 28 | 경악 (흰 눈) |
| 12 | 아야 (> <) | 29 | 어지러움 + 홍조 |
| 13 | 뿌듯 (눈 감고 미소) | 30 | 어지러움 + 땀 |
| 14 | 뾰로통 | 31 | 밝은 미소로 말하기 |
| 15 | 곤란 | 32 | 활짝 웃음 |
| 16 | 부끄러운 당황 (땀) | 99 | 차분히 눈 감음 |

## 앱으로 설치 (PWA)

`/stage` 는 PWA 라서 (메인 화면 `/` 도 같은 방식으로 따로 설치됨: `web/public/cardinal.webmanifest`, 같은 서비스 워커) 안드로이드 Chrome 등에서 "앱 설치 / 홈 화면에 추가"로 설치할 수 있다 (설치하면 주소창 없이 `/stage` 가 바로 열림).

- **HTTPS 또는 `localhost` 에서만 설치됨** (브라우저 규칙). `http://wgnw.worker.ai:16050` 같은 http 주소는 일반 웹페이지로만 동작. 폰에서 쓰려면 HTTPS 로 내보내야 함 (예: Tailscale serve/funnel, Cloudflare Tunnel)
- 메타데이터: `web/public/stage.webmanifest` (이름·`start_url=/stage`·`scope=/stage` 로 메인 앱과 안 겹치게·`display=standalone`·테마색·아이콘 192/512/maskable), iOS 용 `apple-touch-icon.png` 와 메타 태그는 `stage.html`
- `web/public/sw.js`: 설치 조건용 서비스 워커. 해시 붙은 `/assets/*` 와 아이콘만 캐시하고 페이지·API·웹소켓·`/stage-assets` 는 항상 네트워크로 (서버 상태·토큰이 낡아 보이면 안 되므로). 앱 코드를 바꿔도 해시가 달라져 새로 받음
- 오프라인에서는 서버에 붙어야 쓸 수 있어서 동작 안 함 (설치 가능하게만 한 것)

## 내가 보낸 말 표시

보낸 말(글·음성 모두)을 오른쪽 아래, 입력창 바로 위 작은 칸에 잠깐(글자 수에 따라 4~15초) 보여 준다. 음성이 글자로 제대로 바뀌어 보내졌는지 바로 볼 수 있음.

## 파일

| 파일 | |
| --- | --- |
| `web/stage.html`, `web/src/stage-page/` | 페이지 (`main.ts` 연결·입력, `mic.tsx`·`voice.tsx` 음성 입력, `lines.ts` 답 → 대사, `arona.ts` 캐릭터 설정, `stage.css`) |
| `web/src/stage-page/wake.ts` | 호출어: 이름으로 시작하는지 (자모로 풀어 비슷한 것까지) |
| `web/src/stage-page/tts/` | 목소리: `backend.ts` 엔진 둘(기기·호스트)·스트리밍 생성·wav/npy/slerp, `player.ts` 빈틈 없는 PCM 재생(입 모양), `manager.ts` 엔진 고르기·대사 생성 큐·끊기, `voices.ts` 목소리 저장소·엔진별 화자 필드, `panel.tsx` 패널 줄, `designer.tsx` 목소리 디자인 창 |
| `server/cardinal_server/stage_tts.py` | 호스트 TTS 프록시(스트리밍 그대로), zonos3-server 띄우기·끄기, 목소리 저장소 |
| `web/src/asr/listen.ts` | 마이크를 열어 둔 채 16kHz 로 받아 말소리 구간 자르기 (누르는 동안·계속 듣기) |
| `web/src/stage/` | BA-REA 캐릭터 스테이지 모듈 (`src/` 그대로 + `panelToggle.ts`). 고칠 땐 BA-REA 쪽과 맞출 것 |
| `web/vite.config.ts` | `stage.html` 빌드 입력, 개발 서버 `/stage-assets`·`/stage-tts` 프록시 |
| `server/cardinal_server/app.py` | `/stage`, `/stage-assets/…`, `/stage-tts/{engine,models}/…`, `/api/stage/tts/…`, `/api/stage/voices…` |
| `server/cardinal_server/sdk.py` | `turn_start` 이벤트, 관리자 프롬프트의 스테이지 규칙·표정 목록 |
| `server/cardinal_server/config.py` | `CARDINAL_STAGE_ASSETS`, `CARDINAL_STAGE_TTS_*` |

## 확인한 것

임시 홈·포트 7889 SDK 서버, 리소스는 BA-REA 로 링크:

- `/stage` 200, 캐릭터·배경이 뜨고 인사말 나옴. `/stage-assets/../cardinal.db` 같은 바깥 경로는 404
- 스테이지에서 말 걸기 → 관리자가 `[emo:02]`, `[emo:05]`를 붙여 답하고 말풍선·표정이 바뀜 (기록엔 표시 없이)
- REST 로 관리자에게 보낸 일 → 기록에만 남고 말풍선은 안 나옴
- 서버 껐다 켜기 → 스테이지에서 물으니 이전 대화를 기억하고 표정 목록대로 답함
- 메인 화면에 `스테이지` 칩이 나옴
- 음성 입력: 마이크 대신 `say`로 만든 한국어 음성(2.9초)을 넣어 봄 → 끄면 "지금 살아있는 세션이 몇 개인지 알려줘."가 입력창에, 바로 보내기를 켜면 바로 관리자에게 가서 답이 말풍선으로 나옴
- 듣는 방식: 같은 식으로 문장 둘(사이 1.6초 쉼)을 넣어 봄 → 계속 듣기는 두 마디로 끊어서(각각 말이 끝나고 0.8초 뒤) 따로 보냄, 끝난 뒤 조용할 땐 아무것도 안 잡힘. 누르는 동안(`Space` 4.2초)은 첫 문장만 보냄. 버튼은 바로 보내기를 끄면 입력창에. `M` 은 입력창에 쓰는 중엔 안 먹음. 실제 마이크·시끄러운 방에선 아직 안 해 봄
- 호출어: 이름 없는 말 → 이름만 → 이름 없는 부탁 순으로 넣어 봄 → 첫 말은 "이름을 안 불러서 안 보냄", 이름만 부르니 아로나가 "네, 선생님! 말씀하세요.", 이어서 한 "지금 몇 시인지 알려줘"는 이름 없이 보내져 답이 말풍선으로. 답이 끝나고 8초 뒤 다시 `💤 대기`. 이름 맞추기는 13가지 문장으로 따로 확인 ("아론아 …", "아로나야 …", "헤이 아로나, …", "아 로나 …" 은 받고 "아니야 …", "아라 …", "Corona …" 는 안 받음)
- 목소리 (임시 홈·포트 7891 서버, 이 컴퓨터의 zonos3-server :1919, 헤드리스 Chrome + puppeteer):
  - 호스트 프록시: curl 로 `/api/stage/tts/v2/generate` 스트리밍 → 첫 조각 ~145–180ms (직접 붙으면 ~130ms), 12조각으로 나눠 옴 (쌓지 않음). `/v2/edit` 같은 다른 경로는 404, `/stage-tts/models/../..` 는 404
  - 페이지(호스트): 대사 두 줄을 감독 큐에 넣음 → 두 줄 다 말하고 끝남, TTFA ~130–280ms, RTF ~0.27. 세 줄 넣고 1.2초 뒤 끊기 → 셋 다 interrupted, 생성 대기 0
  - 목소리 디자인 UI: 섞기(Seoyeon + Sakura, 말 빠르기 켬) → 캐릭터가 말하기(TTFA 750ms, RTF 0.35) → 저장·캐릭터로. 내 음성(15.5초 wav 파일 올리기) → 저장(reference.wav + 임베딩 192). 둘 다 저장소에서 골라 대사로 말함 (내 음성 첫 줄은 참고 음성 올리기까지 TTFA 2.2초, 섞기는 임베딩 .npy 올려 TTFA 128ms)
  - 모르는 화자 id 로 생성하면 zonos3-server 가 400 "Unknown cached speaker id" → 클라이언트가 다시 올리고 한 번 더 하는 경로. **실제로 zonos3-server 를 다시 켜서 확인하진 않음** (메모리가 모자라 두 번째 서버를 못 띄움)
  - `CARDINAL_STAGE_TTS_CMD`: 가짜 서버(`python3 -m http.server`, `/v2/health` 만)로 띄우기·상태(`managed/running`)·카디널 끌 때 같이 꺼짐 확인. 진짜 zonos3-server 로는 안 해 봄
  - 기기 엔진: 이 컴퓨터는 디스플레이가 없고 GPU 메모리가 거의 차 있어 헤드리스 Chrome 이 SwiftShader(소프트웨어)만 받음 → 자동은 "소프트웨어 WebGPU" 로 보고 호스트를 씀 (의도대로). `forceDevice` 로 강제하면 쿠키 인증으로 모델 ~921MB 를 받아 엔진을 올리고(~99초), `localFetch` 로 목록(27개)·스트리밍 생성까지 됨 (RTF 69). **실제 GPU 에서 속도·소리 품질·자동 전환(RTF ≤ 0.6)은 확인 못 함**
  - 소리를 사람 귀로 들어 보진 않음 (헤드리스). 입 모양(레벨 미터)도 눈으로는 안 봄
