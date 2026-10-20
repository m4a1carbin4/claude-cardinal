"""디스코드 봇 어댑터. 서버가 떠 있는 동안 항상 메시지 이벤트를 받음.

봇 설정: Developer Portal → Bot → Privileged Gateway Intents → MESSAGE CONTENT 켜야 본문이 보임.
"""

import asyncio
import io
import logging

import discord

from .base import InboundAttachment, InboundMessage, OnMessage, OutboundFile, split_text

log = logging.getLogger("cardinal.discord")

MAX_LEN = 2000  # 디스코드 메시지 글자 수 제한
MAX_FILES = 10  # 메시지당 첨부 수 제한


class DiscordAdapter:
    platform = "discord"

    def __init__(self, token: str):
        self.token = token
        intents = discord.Intents.default()
        intents.message_content = True
        self.client = discord.Client(intents=intents)
        self._task: asyncio.Task | None = None
        # connecting → ready / failed: <사유> / closed. /api/health 로 보임
        self.status = "connecting"

    async def start(self, callback: OnMessage) -> None:
        client = self.client

        @client.event
        async def on_ready():
            self.status = "ready"
            log.info("디스코드 연결됨: %s", client.user)

        @client.event
        async def on_message(m: discord.Message):
            if m.author.bot:  # 자기 자신 포함 봇 메시지는 무시 (답장 루프 방지)
                return
            msg = InboundMessage(
                platform=self.platform,
                content=m.content,
                channel_id=str(m.channel.id),
                channel_name=getattr(m.channel, "name", None) or "dm",
                guild=m.guild.name if m.guild else None,
                message_id=str(m.id),
                author=str(m.author),
                mentions_bot=client.user is not None and client.user in m.mentions,
                attachments=[
                    InboundAttachment(filename=a.filename, size=a.size, content_type=a.content_type, url=a.url, read=a.read)
                    for a in m.attachments
                ],
            )
            try:
                await callback(msg)
            except Exception:
                log.exception("메시지 처리 실패")

        self._task = asyncio.create_task(client.start(self.token))
        self._task.add_done_callback(self._on_done)

    def _on_done(self, task: asyncio.Task) -> None:
        # client.start 가 끝났다 = 연결이 끊김. 잘못된 토큰이면 여기서 예외가 나는데,
        # 콜백이 없으면 태스크 안에서 조용히 사라져서 서버는 멀쩡해 보이고 이벤트만 영영 안 옴
        if task.cancelled():
            self.status = "closed"
            return
        err = task.exception()
        if err:
            self.status = f"failed: {type(err).__name__}: {err}"
            log.error("디스코드 연결 실패 → 디스코드 채널 꺼짐: %s: %s", type(err).__name__, err)
        else:
            self.status = "closed"

    async def stop(self) -> None:
        self.status = "closed"
        await self.client.close()
        if self._task:
            self._task.cancel()

    async def _channel(self, channel_id: str):
        cid = int(channel_id)
        return self.client.get_channel(cid) or await self.client.fetch_channel(cid)

    async def send_reply(self, event: dict, text: str, files: list[OutboundFile]) -> list[str]:
        channel = await self._channel(event["channel_id"])
        chunks = split_text(text, MAX_LEN)
        batches = [files[i : i + MAX_FILES] for i in range(0, len(files), MAX_FILES)]
        ids: list[str] = []

        # 첫 메시지는 원래 메시지에 답장으로, 나머지는 이어서 전송
        ref = channel.get_partial_message(int(event["message_id"])) if event.get("message_id") else None
        first = True
        for i in range(max(len(chunks), len(batches), 1)):
            content = chunks[i] if i < len(chunks) else None
            dfiles = [discord.File(io.BytesIO(f.data), filename=f.filename) for f in batches[i]] if i < len(batches) else []
            if first and ref is not None:
                sent = await ref.reply(content=content, files=dfiles, mention_author=False)
            else:
                sent = await channel.send(content=content, files=dfiles)
            ids.append(str(sent.id))
            first = False
        return ids
