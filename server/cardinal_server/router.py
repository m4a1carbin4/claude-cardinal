"""채널 이벤트 → 세션 전달, 세션 → 채널 답장."""

import asyncio
import logging
import re
import secrets
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from .channel.base import Adapter, InboundMessage, OutboundFile
from .config import Settings
from .db import DB, now

log = logging.getLogger("cardinal.router")

MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
AUTO_REPLY_TIMEOUT_S = 900
# 전달을 시작해도 되는 상태. busy/starting 은 CLI 가 idle 될 때까지 기다렸다가 넣음 (최대 600초).
# waiting(승인 대기)은 CLI 가 거부하니까 바로 실패 처리
DELIVERABLE_STATES = {"idle", "busy", "starting"}

# 외부에서 온 글자 중 탭/줄바꿈 빼고 제어 문자는 지움.
# tmux 는 붙여넣기 내용을 거르지 않아서 ESC[201~ 같은 게 그대로 감 (Claude Code 가 걸러주긴 하지만 방어용)
_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def clean(s: str | None) -> str | None:
    return _CTRL.sub("", s) if s else s


def match_route(route: dict, msg: InboundMessage) -> tuple[bool, str]:
    """라우트 조건에 맞으면 (True, 트리거 뗀 본문)"""
    if route["platform"] not in ("*", msg.platform):
        return False, ""
    ch = (route.get("channel") or "").lstrip("#")
    if ch and ch not in (msg.channel_name, msg.channel_id):
        return False, ""

    content = msg.content
    trigger = route.get("trigger")
    kind = route["match"]
    if kind == "mention":
        return msg.mentions_bot, re.sub(r"<@!?\d+>", "", content).strip()
    if not trigger:
        return True, content
    if kind == "prefix":
        return (True, content[len(trigger):].strip()) if content.startswith(trigger) else (False, "")
    if kind == "contains":
        return trigger in content, content
    if kind == "regex":
        try:
            return bool(re.search(trigger, content)), content
        except re.error:
            log.warning("라우트 %s 정규식 오류: %s", route["id"], trigger)
            return False, ""
    return False, ""


def _safe_name(name: str) -> str:
    return re.sub(r"[^\w.\-]+", "_", name).strip("._") or "file"


def format_delivery(ev: dict, route: dict, body: str, cli_path: Path) -> str:
    sdk = route.get("session_backend") == "sdk"
    where = f"{ev['platform']} #{clean(ev.get('channel_name') or ev.get('channel_id')) or '?'}"
    if ev.get("guild"):
        where += f" ({clean(ev['guild'])})"
    body = clean(body) or ""
    lines = [
        f"[cardinal:event {ev['id']}] {where} · {clean(ev.get('author')) or '?'}",
    ]
    if route.get("trigger") or route["match"] == "mention":
        lines.append(f"트리거: {route.get('trigger') or '@멘션'} ({route['match']})")
    lines += ["----", body or "(본문 없음)", "----"]
    atts = ev.get("attachments") or []
    if atts:
        lines.append(f"첨부 {len(atts)}개:")
        for a in atts:
            info = ", ".join(x for x in (a.get("content_type"), f"{(a.get('size') or 0) // 1024}KB") if x)
            lines.append(f"- {clean(a.get('local_path') or a.get('url'))} ({info})" + (f" 저장 실패: {a['error']}" if a.get("error") else ""))
    if route.get("auto_reply"):
        lines.append("이 이벤트는 턴이 끝나면 마지막 응답이 자동으로 답장됨. 따로 보내고 싶으면 아래 도구 사용.")
    if sdk:
        lines.append(f"답장: mcp__cardinal__reply 도구 (event_id={ev['id']}, text, files)")
    else:
        lines.append(f"답장: {cli_path} reply {ev['id']} \"<답장>\" [--file <경로>]")
    return "\n".join(lines)


class Router:
    def __init__(self, settings: Settings, db: DB, sessions: Any, publish: Callable[[dict], Awaitable[None]]):
        self.settings = settings
        self.db = db
        self.sessions = sessions  # sessions.Sessions: 백엔드(tmux/sdk)에 맞춰 보냄
        self.publish = publish  # /ws/channel 로 알림
        self.adapters: dict[str, Adapter] = {}
        self._tasks: set[asyncio.Task] = set()
        # 세션별 전달 락. 한 세션엔 이벤트를 하나씩만 넘김 (CLI 의 세션 락과 별개로 서버 안 순서 보장)
        self._session_locks: dict[str, asyncio.Lock] = {}

    def add_adapter(self, adapter: Adapter) -> None:
        self.adapters[adapter.platform] = adapter

    def _bg(self, coro) -> None:
        t = asyncio.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    # ---------- 받기 ----------

    async def _save_attachments(self, event_id: str, msg: InboundMessage) -> list[dict]:
        out = []
        folder = self.settings.inbox / event_id
        for a in msg.attachments:
            item = {"filename": a.filename, "size": a.size, "content_type": a.content_type, "url": a.url}
            try:
                if a.size and a.size > MAX_ATTACHMENT_BYTES:
                    raise ValueError("25MB 초과")
                data = a.data if a.data is not None else (await a.read() if a.read else None)
                if data is None:
                    raise ValueError("내용 없음")
                folder.mkdir(parents=True, exist_ok=True)
                path = folder / _safe_name(a.filename)
                path.write_bytes(data)
                item["local_path"] = str(path)
                item["size"] = len(data)
            except Exception as e:  # 첨부 하나 실패해도 이벤트는 전달
                item["error"] = str(e)
            out.append(item)
        return out

    async def handle(self, msg: InboundMessage) -> dict:
        """외부 메시지 하나 처리: DB 기록 → 라우트 매칭 → 세션 전달"""
        ev = {
            "id": "evt_" + secrets.token_hex(4),
            "platform": msg.platform,
            "channel_id": msg.channel_id,
            "channel_name": msg.channel_name,
            "guild": msg.guild,
            "message_id": msg.message_id,
            "author": msg.author,
            "content": msg.content,
            "attachments": [],
            "received_at": now(),
        }
        self.db.add_channel_event(ev)

        matched = [(r, body) for r in self.db.active_routes() for ok, body in [match_route(r, msg)] if ok]
        if matched and msg.attachments:
            ev["attachments"] = await self._save_attachments(ev["id"], msg)
            self.db.set_event_attachments(ev["id"], ev["attachments"])

        delivered_to = set()
        for route, body in matched:
            sid = route["session_id"]
            if sid in delivered_to:  # 한 세션에 라우트가 여러 개 걸려도 한 번만
                continue
            delivered_to.add(sid)
            self._bg(self._deliver(ev, route, body))

        await self.publish({"type": "event", "event": ev, "matched": [r["session_name"] for r, _ in matched]})
        return {**ev, "matched": sorted({r["session_name"] for r, _ in matched})}

    async def _deliver(self, ev: dict, route: dict, body: str) -> None:
        sid, name = route["session_id"], route["session_name"]
        if route["session_state"] not in DELIVERABLE_STATES:
            self.db.add_delivery(ev["id"], sid, route["id"], "failed", f"세션 상태 {route['session_state']}")
            return
        text = format_delivery(ev, route, body, self.settings.cli)
        did = self.db.start_delivery(ev["id"], sid, route["id"])
        await self.publish({"type": "delivery", "event_id": ev["id"], "session": name, "status": "pending"})
        status, error = "sent", None
        # 한 세션엔 하나씩. auto_reply 는 답장까지 한 사이클이 끝나야 다음 이벤트로
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            try:
                if route.get("auto_reply"):
                    res = await self.sessions.send(name, text, wait=True, timeout_s=AUTO_REPLY_TIMEOUT_S) or {}
                    if not res.get("accepted"):
                        status, error = "failed", "claude가 받았다는 신호 없음"
                    elif res.get("interrupted"):
                        # 사람이 Esc 로 끼어든 거라 그 턴은 사람 몫. 자동 답장은 안 함
                        error = "사람이 중단함 (Esc) → 자동 답장 안 함"
                    elif res.get("timedOut"):
                        # 전달은 됐음. 턴이 안 끝나서 자동 답장만 못 함 (에이전트가 cardinal reply 로 직접 답할 수는 있음)
                        error = f"턴이 {AUTO_REPLY_TIMEOUT_S}초 안에 안 끝나서 자동 답장 안 함"
                    self.db.finish_delivery(did, status, error)
                    # CLI 가 돌려주는 last 는 이 메시지가 만든 턴의 답 (다음 턴 아님)
                    last = res.get("last")
                    # 누가 됐든 (이 세션, 마스터 등) 이미 이 이벤트에 답장했으면 자동 답장은 생략
                    skip = res.get("timedOut") or res.get("interrupted")
                    if status == "sent" and not skip and last and not self.db.has_reply(ev["id"]):
                        await self.reply(ev["id"], name, last, [], source="auto")
                else:
                    res = await self.sessions.send(name, text)
                    if not (res or {}).get("accepted"):
                        status, error = "failed", "claude가 받았다는 신호 없음"
                    self.db.finish_delivery(did, status, error)
            except Exception as e:
                log.warning("전달 실패 %s → %s: %s", ev["id"], name, e)
                status, error = "failed", str(e)
                self.db.finish_delivery(did, status, error)
        await self.publish({"type": "delivery", "event_id": ev["id"], "session": name, "status": status})

    # ---------- 답장 ----------

    async def reply(self, event_id: str, session_name: str | None, text: str, files: list[OutboundFile],
                    source: str = "tool") -> dict:
        ev = self.db.channel_event(event_id)
        if not ev:
            raise LookupError(f"모르는 이벤트: {event_id}")
        adapter = self.adapters.get(ev["platform"])
        sess = self.db.session_by_name(session_name) if session_name else None
        rec = {
            "event_id": event_id,
            "session_id": sess["id"] if sess else None,
            "source": source,
            "text": text,
            "files": [{"filename": f.filename, "size": len(f.data), "content_type": f.content_type} for f in files],
            "external_ids": [],
            "error": None,
        }
        try:
            if adapter is None:
                raise RuntimeError(f"{ev['platform']} 채널이 연결 안 돼 있음")
            rec["external_ids"] = await adapter.send_reply(ev, text, files)
            rec["status"] = "sent"
        except Exception as e:
            rec["status"] = "failed"
            rec["error"] = str(e)
        saved = self.db.add_reply(rec)
        await self.publish({"type": "reply_saved", "reply": saved})
        if rec["status"] != "sent":
            raise RuntimeError(rec["error"])
        return saved
