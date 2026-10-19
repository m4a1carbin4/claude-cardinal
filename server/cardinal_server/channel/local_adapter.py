"""local 채널: 디스코드 없이 테스트/연동하는 용도.

- 받기: POST /api/channel/inbound, 또는 /ws/channel 웹소켓에 {"type":"message", ...}
- 답장: /ws/channel 구독자한테 {"type":"reply", ...} 로 푸시 (DB에도 남음)
"""

import base64
from collections.abc import Awaitable, Callable

from .base import OnMessage, OutboundFile


class LocalAdapter:
    platform = "local"

    def __init__(self, publish: Callable[[dict], Awaitable[None]]):
        self.publish = publish

    async def start(self, callback: OnMessage) -> None:
        self.callback = callback

    async def stop(self) -> None:
        pass

    async def send_reply(self, event: dict, text: str, files: list[OutboundFile]) -> list[str]:
        await self.publish(
            {
                "type": "reply",
                "event_id": event["id"],
                "channel": event.get("channel_name"),
                "text": text,
                "files": [
                    {"filename": f.filename, "content_type": f.content_type, "data": base64.b64encode(f.data).decode()}
                    for f in files
                ],
            }
        )
        return []
