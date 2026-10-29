"""슬랙 봇 어댑터. Socket Mode 라서 공개 URL 없이 (서버가 127.0.0.1 이어도) 이벤트를 받음.

토큰 두 개: 봇 토큰(xoxb-, SLACK_BOT_TOKEN) 으로 API 호출, 앱 토큰(xapp-, SLACK_APP_TOKEN) 으로 Socket Mode 접속.
앱 설정(권한·이벤트 구독)은 docs/server.md 의 슬랙 봇 설정 참고.
"""

import asyncio
import logging
import re
from collections import OrderedDict

import aiohttp
from slack_sdk.errors import SlackApiError
from slack_sdk.socket_mode.aiohttp import SocketModeClient
from slack_sdk.socket_mode.request import SocketModeRequest
from slack_sdk.socket_mode.response import SocketModeResponse
from slack_sdk.web.async_client import AsyncWebClient

from .base import InboundAttachment, InboundMessage, OnMessage, OutboundFile, split_text

log = logging.getLogger("cardinal.slack")

MAX_LEN = 4000  # 슬랙 권장 글자 수 (한도는 40000 이지만 길면 잘려 보임)
# 받는 메시지 종류. 수정·삭제·입장 같은 건 무시
_SUBTYPES = {None, "file_share", "thread_broadcast"}
_LINK = re.compile(r"<(https?://[^|>]+)(?:\|[^>]*)?>")
_CHANNEL_REF = re.compile(r"<#\w+\|([^>]*)>")


def plain_text(text: str) -> str:
    """슬랙 mrkdwn 을 평문에 가깝게: 링크 <url|글> → url, <#C1|이름> → #이름, &amp; 등 되돌림. <@U1> 멘션은 둠"""
    text = _LINK.sub(r"\1", text)
    text = _CHANNEL_REF.sub(r"#\1", text)
    return text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


class SlackAdapter:
    platform = "slack"

    def __init__(self, bot_token: str, app_token: str):
        self.bot_token = bot_token
        self.web = AsyncWebClient(token=bot_token)
        self.client = SocketModeClient(app_token=app_token, web_client=self.web)
        self.bot_user_id: str | None = None
        self.team: str | None = None
        self._task: asyncio.Task | None = None
        self._callback: OnMessage | None = None
        self._names: dict[str, str] = {}  # 채널·사용자 ID → 이름 (한 번 물어보면 기억)
        # 멘션은 message 와 app_mention 이 둘 다 오고, 재전송도 있어서 (채널, ts) 로 한 번만
        self._seen: OrderedDict[tuple[str, str], None] = OrderedDict()
        # connecting → ready / failed: <사유> / closed. /api/health 로 보임
        self.status = "connecting"

    async def start(self, callback: OnMessage) -> None:
        self._callback = callback
        self.client.socket_mode_request_listeners.append(self._on_request)
        self._task = asyncio.create_task(self._connect())

    async def _connect(self) -> None:
        # 토큰이 틀려도 서버는 계속 뜨고 슬랙만 꺼짐 (디스코드와 같게)
        try:
            auth = await self.web.auth_test()
            self.bot_user_id, self.team = auth["user_id"], auth.get("team")
            await self.client.connect()
            self.status = "ready"
            log.info("슬랙 연결됨: %s (%s)", auth.get("user"), self.team)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # 슬랙 API 오류는 코드만 (invalid_auth, not_allowed_token_type 등)
            why = e.response.get("error") if isinstance(e, SlackApiError) else e
            self.status = f"failed: {type(e).__name__}: {why}"
            log.error("슬랙 연결 실패 → 슬랙 채널 꺼짐: %s: %s", type(e).__name__, why)

    async def stop(self) -> None:
        self.status = "closed"
        if self._task:
            self._task.cancel()
        await self.client.close()

    # ---------- 받기 ----------

    async def _on_request(self, client: SocketModeClient, req: SocketModeRequest) -> None:
        # 3초 안에 ack 안 하면 슬랙이 다시 보냄 → 먼저 ack 하고 처리
        await client.send_socket_mode_response(SocketModeResponse(envelope_id=req.envelope_id))
        if req.type != "events_api":
            return
        event = (req.payload or {}).get("event") or {}
        if event.get("type") not in ("message", "app_mention"):
            return
        try:
            await self._on_message(event)
        except Exception:
            log.exception("메시지 처리 실패")

    async def _on_message(self, e: dict) -> None:
        if e.get("subtype") not in _SUBTYPES:
            return
        # 자기 자신 포함 봇 메시지는 무시 (답장 루프 방지)
        if e.get("bot_id") or not e.get("user") or e.get("user") == self.bot_user_id:
            return
        channel, ts = e.get("channel"), e.get("ts")
        if not channel or not ts or self._seen_before(channel, ts):
            return
        text = e.get("text") or ""
        im = e.get("channel_type") == "im" or channel.startswith("D")
        msg = InboundMessage(
            platform=self.platform,
            content=plain_text(text),
            channel_id=channel,
            channel_name="dm" if im else await self._channel_name(channel),
            guild=self.team,
            # 답장할 자리(스레드 ts): 스레드 안이면 그 스레드, 채널이면 이 메시지에 스레드로, DM 은 스레드 없이
            message_id=e.get("thread_ts") or (None if im else ts),
            author=await self._user_name(e["user"]),
            mentions_bot=e.get("type") == "app_mention" or (self.bot_user_id is not None and f"<@{self.bot_user_id}" in text),
            attachments=[self._attachment(f) for f in e.get("files") or [] if f.get("mode") != "tombstone"],
        )
        if self._callback:
            await self._callback(msg)

    def _seen_before(self, channel: str, ts: str) -> bool:
        key = (channel, ts)
        if key in self._seen:
            return True
        self._seen[key] = None
        while len(self._seen) > 1000:
            self._seen.popitem(last=False)
        return False

    async def _channel_name(self, channel: str) -> str:
        if channel not in self._names:
            try:
                info = await self.web.conversations_info(channel=channel)
                self._names[channel] = info["channel"].get("name") or channel
            except Exception as e:  # channels:read 권한이 없으면 ID 로
                log.warning("슬랙 채널 이름 못 가져옴 %s: %s", channel, e)
                return channel
        return self._names[channel]

    async def _user_name(self, user: str) -> str:
        if user not in self._names:
            try:
                u = (await self.web.users_info(user=user))["user"]
                p = u.get("profile") or {}
                self._names[user] = p.get("display_name") or p.get("real_name") or u.get("name") or user
            except Exception as e:  # users:read 권한이 없으면 ID 로
                log.warning("슬랙 사용자 이름 못 가져옴 %s: %s", user, e)
                return user
        return self._names[user]

    def _attachment(self, f: dict) -> InboundAttachment:
        url = f.get("url_private_download") or f.get("url_private")

        async def read() -> bytes:
            if not url:
                raise ValueError("받을 주소 없음")
            async with aiohttp.ClientSession() as s, s.get(url, headers={"Authorization": f"Bearer {self.bot_token}"}) as r:
                r.raise_for_status()
                # files:read 권한이 없으면 200 으로 로그인 페이지(html)를 줌
                if r.content_type == "text/html" and f.get("mimetype") != "text/html":
                    raise ValueError("파일 대신 로그인 페이지가 옴 (봇에 files:read 권한 필요)")
                return await r.read()

        return InboundAttachment(filename=f.get("name") or f.get("id") or "file", size=f.get("size"),
                                 content_type=f.get("mimetype"), url=f.get("permalink") or url, read=read)

    # ---------- 답장 ----------

    async def send_reply(self, event: dict, text: str, files: list[OutboundFile]) -> list[str]:
        channel, thread = event["channel_id"], event.get("message_id")
        ids: list[str] = []
        for chunk in split_text(text, MAX_LEN):
            r = await self.web.chat_postMessage(channel=channel, text=chunk, thread_ts=thread)
            ids.append(r["ts"])
        if files:
            r = await self.web.files_upload_v2(
                channel=channel, thread_ts=thread,
                file_uploads=[{"file": f.data, "filename": f.filename, "title": f.filename} for f in files],
            )
            ids += [f["id"] for f in r.get("files") or []]
        return ids
