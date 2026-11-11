# Stage (talk to the admin through a character)

[한국어](stage.md) · Related: [admin session](admin-session.en.md), [SDK mode](sdk-mode.en.md)

The `/stage` page. A character (Arona) and a background fill the screen, and what you type in the box at the bottom **goes straight to the admin session**. The admin's replies come out as the character's speech bubbles, with the expression changing per paragraph. The character module comes from BA-REA (Character Stage).

The `스테이지` chip at the top of the main UI opens it in a new tab (shown only when there is an admin session).

## Assets (not in the repo)

The character and background are extracted from the Blue Archive client, so they are **not in the repo and must not be redistributed**. The server serves them at `/stage-assets/…` from `CARDINAL_STAGE_ASSETS` (default `~/.cardinal/stage-assets`).

```
~/.cardinal/stage-assets/
  arona_spr/arona_spr.skel, arona_spr.atlas, arona_spr.png   # Spine 4.2
  bg/BG_AronaRoom.jpg
```

Same layout as BA-REA's `public/game-assets`, so a link is enough:

```
ln -s ~/BA-REA/public/game-assets ~/.cardinal/stage-assets
```

Without them the page shows "캐릭터를 못 불러옴" (couldn't load the character) and chatting still works.

`/stage-assets` requires the same token as the API (`CARDINAL_TOKEN`). The spine loader can't add headers, so the stage page sets a `cardinal_token` cookie (path `/stage-assets` only).

## Flow

1. The page gets the admin's name from `/api/health` and connects to `/ws/sdk/<admin>`
2. What you type is sent as `[스테이지] <text>`. The admin prompt says to answer such messages briefly, without markdown, with `[emo:NN]` expressions
3. The server sends `turn_start` (`origin`, `prompt`) when a turn starts → the page knows whether the current turn came from the stage
4. Only replies (`AssistantMessage` text) to stage turns are spoken. Replies to work from elsewhere (web chat tab, channels, MCP) only go to the log on the left. Turn on `다른 곳 대화도 읽기` (read other conversations too) to speak those as well
5. Reply → lines: code blocks become "(see the chat tab for code)", tables and rules are dropped, markdown symbols are stripped, one chunk per paragraph (split at sentence ends past 160 chars). `[emo:NN]` sets the expression from that paragraph on

Also:

- 🎤 voice input: see [Voice input](#voice-input) below
- `중단` (stop): stops the bubbles and interrupts the admin's turn
- If the admin asks a question (permission / AskUserQuestion), the log says so. Answer it in the main UI's chat tab
- Touching the character (head pats, tapping the halo or body) reacts only on the page and is not sent to the admin (saves tokens)
- `H` or the top-right button hides the left panel
- From devtools: `stage.agent.play({ text, emotion })`, `renderer.setExpression('05')`

## Voice input

Speech is turned into text by the same in-browser Whisper as the main UI's chat tab (audio never goes to the server, only text). Model, language and `인식되면 바로 보내기` (send on recognition) are shared with the chat tab (`localStorage` `cardinal.asr`). Pick one of three listening modes under ⚙ (`cardinal.stage.voice`, this browser only):

| Mode | What it does | Sending |
| --- | --- | --- |
| 버튼 (button) | 🎤 starts recording, press again to stop (same as the chat tab) | follows send-on-recognition; off → appended to the input box |
| 누르는 동안 (push-to-talk) | listens only while 🎤 or `Space` is held | right on release |
| 계속 듣기 (hands-free) | while on, cuts each thing you say and sends it. `M` toggles it | each utterance right away |

- Push-to-talk and hands-free show a mic level bar in the button. `Space` and `M` are ignored while typing in the input box
- Push-to-talk: the mic opens on the first press and closes after a minute unused. While open, the 0.32 s before the press is included so the first sound isn't cut
- Hands-free: the mic stays open while it's on. End-of-turn pause (default 0.8 s) and sensitivity are under ⚙. Common phrases Whisper invents from noise ("감사합니다", "시청해 주셔서 감사합니다", "Thank you", …) are dropped when that's all it heard
- It keeps listening while earlier utterances are transcribed (one at a time)
- Wake word (hands-free, ⚙ `이름을 부를 때만 보내기` / send only when called by name): only utterances starting with the name (default `아로나`) are sent, with the name removed ("아로나, 오늘 날씨 어때?" → "오늘 날씨 어때?"). The button shows `💤 “아로나” 대기` (waiting)
  - Saying just the name sends nothing to the admin; Arona answers ("네, 선생님! 말씀하세요.") and the next thing you say is taken without the name
  - While the admin works on something sent from the stage, and for a few seconds after the reply ends (`답 뒤 이름 없이`, default 8 s), no name is needed
  - Tolerates Whisper spelling the name a little differently: Hangul is compared letter by letter (jamo), allowing about one letter off ("아론아", "아로나야", "헤이 아로나", "아로나 씨"). `web/src/stage-page/wake.ts`

The turn-taking follows [ming-voice](https://github.com/JMS1717/ming-voice). Differences:

| | ming-voice | Stage |
| --- | --- | --- |
| Capture | AudioWorklet downsampling to 16 kHz, 512 samples (32 ms) per frame, sent to the server | same, used only in the browser (`web/src/asr/listen.ts`) |
| Speech detection | Silero VAD on the server (+ energy to time the pause sooner) | energy: some multiple above the background noise (measured for 0.5 s, then tracked while quiet) is speech, 20 dB under the speaking level is quiet |
| End of turn | 0.5 s pause, +0.25 s for utterances under 1 s, Smart Turn model judges finished / not finished | pause (default 0.8 s, adjustable), +0.25 s for short ones. No turn model |
| Start | 0.32 s pre-roll | same |
| Barge-in, echo | filters its own voice coming back through the mic | the stage makes no sound, so not needed |
| Modes | hands-free / wake word / push-to-talk (Space) | hands-free (+ wake word) / push-to-talk (Space) / button |
| Wake word | transcribes the first seconds while you're still talking to check the name; name alone → chime; 8 s after a reply without the name | checks after the utterance is transcribed; name alone → Arona answers; no name needed during a stage turn and 8 s (adjustable) after the reply |

## Expressions

Named by showing each one. The admin prompt has the same list.

| No. | Expression | No. | Expression |
| --- | --- | --- | --- |
| 00 | default smile | 17 | dizzy (swirl eyes) |
| 01 | smile (blinks) | 18 | embarrassed shout (> <, blush) |
| 02 | surprised (round mouth) | 19 | embarrassed fluster |
| 03 | eye smile (happy) | 20 | talking brightly |
| 04 | flustered (sweat) | 21 | excited (sparkle eyes, heart) |
| 05 | sulking (orange halo) | 22 | determined (sparkle eyes) |
| 06 | teary | 23 | sleepy (drool) |
| 07 | troubled (clenched teeth) | 24 | yawn |
| 08 | talking excitedly | 25 | realization (sparkle eyes, surprised) |
| 09 | awkward laugh | 26 | unimpressed |
| 10 | sigh (eyes closed) | 27 | grumbling |
| 11 | very happy (heart halo) | 28 | shocked (blank eyes) |
| 12 | ouch (> <) | 29 | dizzy + blush |
| 13 | proud (eyes closed, smile) | 30 | dizzy + sweat |
| 14 | pouting | 31 | talking with a bright smile |
| 15 | troubled | 32 | big smile |
| 16 | embarrassed fluster (sweat) | 99 | calm, eyes closed |

## Install as an app (PWA)

`/stage` is a PWA (the main page `/` installs separately the same way: `web/public/cardinal.webmanifest`, same service worker): Android Chrome and others offer "Install app / Add to Home screen" (it then opens `/stage` without the address bar).

- **Installs only over HTTPS or `localhost`** (browser rule). A plain-http address such as `http://wgnw.worker.ai:16050` works as a normal page only. To use it on a phone, serve it over HTTPS (e.g. Tailscale serve/funnel, Cloudflare Tunnel)
- Metadata: `web/public/stage.webmanifest` (name, `start_url=/stage`, `scope=/stage` so it doesn't overlap the main app, `display=standalone`, theme colour, 192/512/maskable icons); the iOS `apple-touch-icon.png` and meta tags are in `stage.html`
- `web/public/sw.js`: a service worker for installability. It caches only the hashed `/assets/*` and icons; pages, API, websockets and `/stage-assets` always go to the network (so server state and tokens are never stale). Rebuilt code gets new hashes and is fetched fresh
- It does not work offline (it needs the server); the worker only makes it installable

## Echo of what you sent

What you sent (typed or by voice) shows for a few seconds (4-15 s, by length) in a small box at the bottom right, just above the input bar, so you can see that speech was transcribed correctly.

## Files

| File | |
| --- | --- |
| `web/stage.html`, `web/src/stage-page/` | the page (`main.ts` connection and input, `mic.tsx` / `voice.tsx` voice input, `lines.ts` reply → lines, `arona.ts` character config, `stage.css`) |
| `web/src/stage-page/wake.ts` | wake word: does it start with the name (close matches via jamo) |
| `web/src/asr/listen.ts` | keeps the mic open, takes 16 kHz frames and cuts out speech (push-to-talk, hands-free) |
| `web/src/stage/` | BA-REA character stage module (`src/` as is + `panelToggle.ts`). Keep it in step with BA-REA when changing it |
| `web/vite.config.ts` | `stage.html` build input, dev server `/stage-assets` proxy |
| `server/cardinal_server/app.py` | `/stage`, `/stage-assets/…` |
| `server/cardinal_server/sdk.py` | `turn_start` event, stage rules and expression list in the admin prompt |
| `server/cardinal_server/config.py` | `CARDINAL_STAGE_ASSETS` |

## Tested

SDK server on a scratch home and port 7889, assets linked to BA-REA:

- `/stage` 200, character and background load and the greeting shows. Paths outside like `/stage-assets/../cardinal.db` → 404
- Talking on the stage → the admin answered with `[emo:02]`, `[emo:05]`, bubbles and expression changed (log shows the text without tags)
- Work sent to the admin over REST → only in the log, no bubble
- Server stop and start → asked from the stage, it remembered the previous exchange and answered using the expression list
- The main UI shows the `스테이지` chip
- Voice input: fed a 2.9 s Korean clip made with `say` instead of the mic → with send-on-recognition off the text landed in the input box, with it on it went straight to the admin and the reply came out as bubbles
- Listening modes: fed two sentences the same way (1.6 s gap) → hands-free cut them into two utterances (each 0.8 s after it ended) and sent them separately, nothing was picked up in the silence after. Push-to-talk (`Space` held 4.2 s) sent only the first sentence. Button with send-on-recognition off put the text in the input box. `M` is ignored while typing. Not yet tried with a real mic or a noisy room
- Wake word: fed no-name sentence → name alone → no-name request → the first was dropped ("이름을 안 불러서 안 보냄"), the name alone made Arona answer "네, 선생님! 말씀하세요.", the following "지금 몇 시인지 알려줘" was sent without the name and the reply came out as bubbles. 8 s after the reply ended it went back to `💤 대기`. Name matching checked separately on 13 sentences ("아론아 …", "아로나야 …", "헤이 아로나, …", "아 로나 …" accepted; "아니야 …", "아라 …", "Corona …" rejected)
