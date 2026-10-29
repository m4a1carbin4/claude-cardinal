# Slack channel

[한국어](slack.md) · Related: [server](server.en.md) (channel, route, reply flow), [Cardinal MCP](mcp.en.md)

Like Discord: Slack messages go to sessions by route, and the session answers with `mcp__cardinal__reply` (or `cardinal reply`). Routes, auto reply and attachment saving are the same code as Discord ([server](server.en.md) flows C–E). Only exists while the server is up.

It connects with **Socket Mode**: the server opens a websocket to Slack and receives events over it. So no public URL (Request URL) is needed, and the server can stay on 127.0.0.1.

## Turning it on

Both tokens are needed. With only one, a warning is logged and Slack stays off.

| Env var | |
| --- | --- |
| `SLACK_BOT_TOKEN` | bot token `xoxb-…`. Sending, channel/user names, file download/upload |
| `SLACK_APP_TOKEN` | app token `xapp-…` (scope `connections:write`). Socket Mode connection |

```sh
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… uv run cardinal-server
# server under launchd: reinstall with the tokens (they land in the plist in plain text)
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… ./autostart.sh install --sdk
```

It's connected when the log shows `슬랙 연결됨: <bot name> (<workspace>)` and `channels.slack` in `GET /api/health` is `ready`. A wrong token shows the Slack error code, like `failed: SlackApiError: invalid_auth`, and only Slack is off (the server keeps running). The web UI header also shows a "슬랙" status (hidden when off).

## Creating the Slack app

1. https://api.slack.com/apps → **Create New App** → **From a manifest** → pick the workspace → paste the YAML below → Create.
2. **Basic Information → App-Level Tokens → Generate Token and Scopes**: any name, scope `connections:write` → the `xapp-…` is `SLACK_APP_TOKEN`.
3. **Install App → Install to Workspace** → Allow → the **Bot User OAuth Token** `xoxb-…` is `SLACK_BOT_TOKEN`.
4. `/invite @Cardinal` in the channels the bot should see. Only messages from channels the bot is in arrive (DMs just work).

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

What the scopes do: `*:history` + `message.*` events = receive messages, `app_mentions:read` = receive mentions, `*:read`/`users:read` = channel and user names, `chat:write` = reply, `files:read`/`files:write` = download/upload attachments. For mentions only, drop `message.*` and `*:history` (then only `match: mention` routes match). After changing scopes, reinstall the app.

## Routes

```json
{"platform":"slack","channel":"dev","trigger":"!ask","match":"prefix"}
{"platform":"slack","match":"mention","auto_reply":true}
```

- `channel` is the channel name (`dev`, `#dev`) or ID (`C0123…`). DMs are named `dm`.
- `mention` is a message that `@`s the bot. The `<@U…>` mention is stripped from the body.
- The web UI route form has `slack` under platform. `platform: "*"` matches Discord, Slack and local.

## Incoming messages

`message` (channels, private channels, DMs, group DMs) and `app_mention` events become an `InboundMessage`.

| Field | Value |
| --- | --- |
| `channel_id` / `channel_name` | channel ID / name (`conversations.info`, cached). DMs are `dm` |
| `guild` | workspace name |
| `author` | display name → real name → user name (`users.info`, cached) |
| `message_id` | **thread ts to reply in**: the thread if inside one, the message ts for channel messages, empty for DMs |
| `mentions_bot` | `app_mention`, or `<@bot>` in the text |
| `content` | links `<url\|text>` → `url`, `<#C1\|name>` → `#name`, `&amp;`/`&lt;`/`&gt;` unescaped |
| attachments | `url_private_download` fetched with the bot token. Without `files:read` Slack returns a login page (html) with 200; that's caught as an error |

- Ignored: bot messages (including itself, to avoid reply loops), subtypes like edits, deletes, joins (`file_share` and `thread_broadcast` are kept).
- Mentions arrive as both `message` and `app_mention`, and Slack sometimes redelivers, so each (channel, ts) is handled once.
- Slack wants an ack within 3 seconds, so it acks first and then handles.

## Replies

- Channel messages get the reply **in that message's thread** (keeps the channel clean). Messages from a thread get it in that thread. DMs get it without a thread.
- Text is split into 4000-char chunks (Slack's recommended length). Files go up with `files_upload_v2` into the same thread.
- File limits are the existing CLI/reply API ones (10 files, 10MB each).
- The returned IDs are the sent message ts values and uploaded file IDs.

## Files

| File | |
| --- | --- |
| `server/cardinal_server/channel/slack_adapter.py` | Socket Mode connection, event → `InboundMessage`, replies |
| `server/cardinal_server/app.py` | starts the adapter when tokens are set, `slack` in `/api/health` |
| `server/cardinal_server/router.py` | mention stripping (`<@U…>`, `<@U…\|name>`) |

## Tested / not yet

- With the Slack API faked: channel message, duplicate mention, bot message, edit event, thread, DM + file conversion, route matching (mention, prefix), 4000-char split, thread reply, DM reply, file upload args
- Attachment download against a local HTTP server (Bearer token, login page → error)
- Server start with fake tokens → server up, `slack: failed: SlackApiError: invalid_auth`
- **Not yet run against a real Slack workspace** (no tokens)
