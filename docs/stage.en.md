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

- 🎤 voice input: the same component as the main UI's chat tab (`MicInput`, in-browser Whisper, audio never goes to the server). Shares the model, language and `인식되면 바로 보내기` (send on recognition) settings (`localStorage` `cardinal.asr`). With send-on-recognition the text goes straight to the admin, otherwise it's appended to the input box. ⚙ settings and notes pop up above the input bar
- `중단` (stop): stops the bubbles and interrupts the admin's turn
- If the admin asks a question (permission / AskUserQuestion), the log says so. Answer it in the main UI's chat tab
- Touching the character (head pats, tapping the halo or body) reacts only on the page and is not sent to the admin (saves tokens)
- `H` or the top-right button hides the left panel
- From devtools: `stage.agent.play({ text, emotion })`, `renderer.setExpression('05')`

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

## Files

| File | |
| --- | --- |
| `web/stage.html`, `web/src/stage-page/` | the page (`main.ts` connection and input, `mic.tsx` voice input, `lines.ts` reply → lines, `arona.ts` character config, `stage.css`) |
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
