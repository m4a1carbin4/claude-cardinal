"""메시지 채널 공통 타입. 플랫폼(디스코드 등)마다 어댑터 하나."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class InboundAttachment:
    filename: str
    size: int | None = None
    content_type: str | None = None
    url: str | None = None
    read: Callable[[], Awaitable[bytes]] | None = None  # 내용 가져오기 (어댑터가 채움)
    data: bytes | None = None  # 이미 내용이 있으면 (local)


@dataclass
class InboundMessage:
    platform: str
    content: str
    channel_id: str | None = None
    channel_name: str | None = None
    guild: str | None = None
    message_id: str | None = None
    author: str | None = None
    mentions_bot: bool = False
    attachments: list[InboundAttachment] = field(default_factory=list)


@dataclass
class OutboundFile:
    filename: str
    data: bytes
    content_type: str | None = None


OnMessage = Callable[[InboundMessage], Awaitable[None]]


class Adapter(Protocol):
    platform: str

    async def start(self, on_message: OnMessage) -> None: ...

    async def stop(self) -> None: ...

    async def send_reply(self, event: dict, text: str, files: list[OutboundFile]) -> list[str]:
        """event(channel_events 행)에 답장. 보낸 메시지 ID 목록 반환"""
        ...


def split_text(text: str, limit: int) -> list[str]:
    """글자 수 제한 넘으면 줄 단위로 최대한 안 끊기게 나눔"""
    if len(text) <= limit:
        return [text] if text else []
    out: list[str] = []
    cur = ""
    for line in text.splitlines(keepends=True):
        while len(line) > limit:  # 한 줄이 제한보다 길면 강제로 자름
            if cur:
                out.append(cur)
                cur = ""
            out.append(line[:limit])
            line = line[limit:]
        if len(cur) + len(line) > limit:
            out.append(cur)
            cur = ""
        cur += line
    if cur:
        out.append(cur)
    return out
