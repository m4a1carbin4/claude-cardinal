"""세션끼리 쓰는 기본 채널(버스): 마스터·워커·관리자 모든 세션이 따로 설정 없이 같이 쓰는 비동기 메시지 통로.

보내는 쪽은 메시지를 넣고 바로 돌아옴 (받는 쪽이 일을 끝내길 기다리지 않음). 받는 쪽엔 서버가 세션 입력으로 넣어 주고
(작업 중이면 끝난 뒤 차례로), 일을 마친 쪽은 같은 도구로 결과를 보낸 쪽에 돌려보냄.
외부 채널(디스코드·슬랙)과 달리 라우트 설정이 필요 없음. 기록은 DB(bus_messages / bus_deliveries), 실시간은 /ws/channel.
"""

import asyncio
import logging
import secrets
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from typing import Any

from .db import DB, now
from .router import DELIVERABLE_STATES, clean

log = logging.getLogger("cardinal.bus")

MAX_TEXT = 20_000          # 메시지 하나 글자 수 (더 큰 건 웹드라이브에 쓰고 경로만 보냄)
MAX_RECIPIENTS = 20
RATE_MAX = 30              # 세션 하나가 RATE_WINDOW_S 동안 보낼 수 있는 메시지 수
RATE_WINDOW_S = 60
MAX_DEPTH = 40             # 한 스레드에서 답이 이어질 수 있는 단계 (서로 계속 답하는 핑퐁 막기)
KINDS = ("task", "result", "info")
SYSTEM = {"id": "system", "name": "cardinal", "role": "system"}


class BusError(Exception):
    pass


def format_message(msg: dict, to_row: dict) -> str:
    """받는 세션 입력으로 들어갈 글"""
    mcp = to_row.get("backend") == "sdk" or bool(to_row.get("mcp"))
    frm = clean(msg["from_name"])
    head = f"[cardinal:msg {msg['id']}] {frm} → 너"
    if msg["broadcast"]:
        head += " (전체 방송)"
    if msg.get("reply_to"):
        head += f" · {msg['reply_to']} 에 대한 {'결과' if msg['kind'] == 'result' else '답'}"
    lines = [head, "----", clean(msg["text"]) or "", "----"]
    if msg["kind"] == "task" and msg["from_id"] != SYSTEM["id"]:
        if mcp:
            lines.append(
                "세션끼리 쓰는 비동기 채널 메시지임: 보낸 세션은 기다리지 않고 있고, 이 메시지가 일 시킨 거라면 일을 마친 뒤 "
                f"mcp__cardinal__channel_post 도구로 결과를 보내야 전달됨 (to=\"{frm}\", reply_to=\"{msg['id']}\", text=결과). "
                "응답 텍스트만으로는 안 감.")
        else:
            lines.append("세션끼리 쓰는 채널 메시지지만 이 세션은 카디널 MCP 에 안 붙어 있어 채널로 답할 수 없음 (사람에게 알려줘).")
    elif msg["kind"] == "result":
        lines.append("(결과 보고: 다시 답장하지 않아도 됨. 필요한 후속 일만 이어서 하고, 사람에게 보여줄 정리는 네 응답으로.)")
    return "\n".join(lines)


class Bus:
    def __init__(self, db: DB, sessions: Any, publish: Callable[[dict], Awaitable[None]]):
        self.db = db
        self.sessions = sessions  # sessions.Sessions: 백엔드(tmux/sdk)에 맞춰 보냄
        self.publish = publish  # /ws/channel 로 알림
        self._tasks: set[asyncio.Task] = set()
        # 한 세션엔 메시지를 하나씩만 (여러 곳에서 동시에 보내도 순서대로 들어감)
        self._locks: dict[str, asyncio.Lock] = {}

    def _bg(self, coro) -> None:
        t = asyncio.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    # ---------- 보내기 ----------

    def _recipients(self, me: dict, to: list[str] | str) -> tuple[list[dict], bool]:
        names = [to] if isinstance(to, str) else list(to)
        names = [n.strip() for n in names if n and n.strip()]
        if not names:
            raise BusError("받는 세션(to)이 필요")
        if "*" in names:
            if me["role"] not in ("master", "system"):
                raise BusError("전체 방송(to=\"*\")은 마스터·관리자만")
            rows = [s for s in self.db.sessions() if s["alive"] and s["id"] != me["id"]]
            if not rows:
                raise BusError("방송을 받을 살아있는 다른 세션이 없음")
            return rows, True
        rows, seen = [], set()
        for n in names:
            if n in seen:
                continue
            seen.add(n)
            row = self.db.session_by_name(n)
            if not row or row.get("deleted_at"):
                raise BusError(f"모르는 세션: {n} (session_list 로 확인)")
            if row["id"] == me["id"]:
                raise BusError("자기 자신에게는 못 보냄")
            if not row["alive"]:
                raise BusError(f"살아있지 않은 세션: {n} ({row['state']})")
            rows.append(row)
        return rows, False

    async def post(self, me: dict, to: list[str] | str, text: str, *, reply_to: str | None = None,
                   kind: str | None = None) -> dict:
        text = (text or "").strip()
        if not text:
            raise BusError("보낼 텍스트가 필요")
        if len(text) > MAX_TEXT:
            raise BusError(f"메시지가 너무 긺 ({len(text)} > {MAX_TEXT}자): 웹드라이브에 파일로 쓰고 경로만 보내")
        parent = None
        if reply_to:
            parent = self.db.bus_message(reply_to)
            if not parent:
                raise BusError(f"모르는 메시지: {reply_to}")
        rows, broadcast = self._recipients(me, to)
        # 기본: 답하는 거면 결과, 전체 방송이면 알림 (모두에게 답을 기대하지 않음), 아니면 일 지시
        kind = kind or ("result" if parent else "info" if broadcast else "task")
        if kind not in KINDS:
            raise BusError(f"kind 는 {', '.join(KINDS)} 중 하나")
        depth = (parent["depth"] + 1) if parent else 0
        if depth > MAX_DEPTH:
            raise BusError(f"스레드가 너무 길어짐 ({MAX_DEPTH}단계): 서로 계속 답하고 있는 건 아닌지 확인하고 사람에게 알려")
        if me["id"] != SYSTEM["id"]:
            since = (datetime.now(timezone.utc) - timedelta(seconds=RATE_WINDOW_S)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            if self.db.bus_recent_posts(me["id"], since) >= RATE_MAX:
                raise BusError(f"너무 많이 보냄 (1분에 {RATE_MAX}개까지)")
        if len(rows) > MAX_RECIPIENTS:
            raise BusError(f"한 번에 {MAX_RECIPIENTS}개 세션까지")

        mid = "msg_" + secrets.token_hex(4)
        msg = self.db.add_bus_message({
            "id": mid, "at": now(), "from_id": me["id"], "from_name": me["name"],
            "to_names": [r["name"] for r in rows], "broadcast": broadcast, "kind": kind, "text": text,
            "reply_to": reply_to, "thread": parent["thread"] if parent else mid, "depth": depth,
        })
        await self.publish({"type": "bus", "message": msg})
        for r in rows:
            self._bg(self._deliver(msg, r))
        return msg

    # ---------- 전달 ----------

    async def _deliver(self, msg: dict, row: dict) -> None:
        sid, name = row["id"], row["name"]
        did = self.db.start_bus_delivery(msg["id"], sid, name)
        status, error = "sent", None
        async with self._locks.setdefault(sid, asyncio.Lock()):
            try:
                # 보내는 사이 상태가 바뀌었을 수 있으니 지금 상태로
                cur = self.db.session_by_id(sid) or row
                if not cur["alive"] or cur.get("deleted_at"):
                    raise BusError("세션이 끝났음")
                if cur["state"] not in DELIVERABLE_STATES:
                    raise BusError(f"세션 상태 {cur['state']} (승인/질문 대기 중이면 먼저 풀어야 들어감)")
                res = await self.sessions.send(name, format_message(msg, cur))
                if not (res or {}).get("accepted"):
                    raise BusError("claude가 받았다는 신호 없음")
            except Exception as e:
                log.warning("채널 전달 실패 %s → %s: %s", msg["id"], name, e)
                status, error = "failed", str(e)
        self.db.finish_bus_delivery(did, status, error)
        await self.publish({"type": "bus_delivery", "msg_id": msg["id"], "session": name, "status": status, "error": error})
        # 방송은 일부가 못 받아도 흔한 일이라 알리지 않음 (기록엔 남음)
        if status == "failed" and msg["from_id"] != SYSTEM["id"] and not msg["broadcast"]:
            await self._tell_sender(msg, name, error or "")

    async def _tell_sender(self, msg: dict, target: str, error: str) -> None:
        """안 들어갔으면 보낸 쪽이 영원히 기다리지 않게 알림 (카디널이 보냄)"""
        sender = self.db.session_by_id(msg["from_id"])
        if not sender or not sender["alive"] or sender.get("deleted_at"):
            return
        try:
            await self.post(SYSTEM, [sender["name"]], f"{msg['id']} 를 {target} 에게 못 넘김: {error}", kind="info",
                            reply_to=msg["id"])
        except Exception as e:  # 알림이 안 가도 원래 흐름은 그대로
            log.warning("전달 실패 알림 못 보냄 %s: %s", msg["id"], e)

    # ---------- 읽기 ----------

    def read(self, me: dict, limit: int = 20, thread: str | None = None) -> list[dict]:
        """내가 보냈거나 받은 메시지 (오래된 것부터). 내가 보낸 건 전달 결과도"""
        msgs = self.db.bus_messages(min(max(limit, 1), 100), session=me["name"], thread=thread)[::-1]
        for m in msgs:
            if m["from_id"] == me["id"]:
                m["deliveries"] = [{"to": d["session_name"], "status": d["status"], "error": d["error"]}
                                   for d in self.db.bus_deliveries(m["id"])]
        return msgs
