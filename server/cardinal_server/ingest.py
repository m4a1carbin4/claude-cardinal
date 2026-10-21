"""~/.cardinal 파일 → SQLite 수집.

- sessions/<이름>/meta.json: 이름 ↔ 인스턴스(instanceId) 연결 (CLI가 씀)
- hooks/<instanceId>/state.json, events.jsonl: 그 인스턴스 훅만 씀

훅과 CLI는 지금처럼 파일에만 씀. 서버가 꺼져 있어도 기록은 안 날아가고, 켜지면 오프셋부터 따라잡음.
"""

import asyncio
import json
import logging
import re
from datetime import datetime
from collections.abc import Callable
from pathlib import Path

from watchfiles import awatch

from .config import Settings
from .db import DB

log = logging.getLogger("cardinal.ingest")


def _read_json(p: Path) -> dict | None:
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return None


# ---- Esc 중단 판정 (CLI src/transcript.ts 의 interruptedAt 과 같은 규칙) ----
# Esc 로 중단하면 Stop 훅이 안 와서 state.json 이 busy 에 남음. CLI 는 조회할 때 보정하지만
# 아무도 CLI 를 안 부르면 DB/웹 UI 가 계속 busy 라서, 수집할 때도 트랜스크립트 끝을 보고 보정 (DB만, 파일은 안 건드림)
_INTERRUPT = re.compile(r"^\[Request interrupted by user")
_NON_HUMAN = re.compile(r"^(<command-name>|<command-message>|<local-command-|<task-notification>|This session is being continued|Caveat: )")
_TAIL_BYTES = 512 * 1024


def _user_kind(rec: dict, has_origin: bool) -> str | None:
    if rec.get("type") != "user" or rec.get("isMeta") or rec.get("isSidechain"):
        return None
    c = (rec.get("message") or {}).get("content")
    if isinstance(c, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
            return None
        c = "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    if not isinstance(c, str) or not c:
        return None
    t = c.strip()
    if _INTERRUPT.match(t):
        return "interrupt"
    origin = (rec.get("origin") or {}).get("kind")
    if origin == "task-notification" or t.startswith("<task-notification>"):
        return "agent"
    if has_origin:
        return "human" if origin == "human" else "ignore"
    return "ignore" if _NON_HUMAN.match(t) else "human"


def interrupted_at(path: str | None) -> str | None:
    """마지막 사람 입력 뒤로 Esc 중단이 있으면 그 시각"""
    if not path:
        return None
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - _TAIL_BYTES))
            raw = f.read().decode("utf-8", "replace")
    except OSError:
        return None
    has_origin = '"origin":{"kind"' in raw
    for line in reversed(raw.split("\n")):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        kind = _user_kind(rec, has_origin)
        if kind in (None, "ignore"):
            continue
        return rec.get("timestamp") if kind == "interrupt" else None
    return None


def _ts(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def apply_interrupt(state: dict | None) -> dict | None:
    if not state or state.get("state") not in ("busy", "waiting"):
        return state
    at = interrupted_at(state.get("transcriptPath"))
    if not at or not state.get("at") or _ts(at) < _ts(state["at"]):
        return state
    return {**state, "state": "idle", "at": at, "event": "Interrupted", "detail": "사람이 중단함 (Esc)", "tool": None}


async def _tmux_sessions() -> set[str]:
    proc = await asyncio.create_subprocess_exec(
        "tmux", "list-sessions", "-F", "#{session_name}",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    # tmux 서버 자체가 없으면 실패 → 세션 없음
    return set(out.decode().split()) if proc.returncode == 0 else set()


class Ingestor:
    def __init__(self, settings: Settings, db: DB, on_change: Callable[[], None]):
        self.settings = settings
        self.db = db
        self.on_change = on_change
        self._kick = asyncio.Event()
        self._last_snapshot = ""
        self._lock = asyncio.Lock()

    def kick(self) -> None:
        """다음 동기화를 바로 돌리게"""
        self._kick.set()

    def _tail_events(self, session_id: str, path: Path) -> int:
        offset = self.db.get_offset(session_id)
        try:
            size = path.stat().st_size
        except OSError:
            return 0
        if size <= offset:
            return 0
        with path.open("rb") as f:
            f.seek(offset)
            chunk = f.read(size - offset)
        # 쓰는 중인 마지막 줄은 다음에
        end = chunk.rfind(b"\n")
        if end < 0:
            return 0
        lines = []
        for raw in chunk[: end + 1].splitlines():
            try:
                lines.append(json.loads(raw))
            except ValueError:
                log.warning("events.jsonl 파싱 실패 (%s): %r", session_id, raw[:120])
        self.db.add_session_events(session_id, lines, offset + end + 1)
        return len(lines)

    def _hook_dir(self, meta: dict, name_dir: Path) -> Path:
        """이 세션 인스턴스의 훅 폴더. 예전 방식 세션(instanceId 없음)은 이름 폴더를 같이 씀"""
        iid = meta.get("instanceId")
        return self.settings.hooks_dir / iid if iid else name_dir

    async def sync(self) -> None:
        async with self._lock:
            alive = await _tmux_sessions()
            seen: set[str] = set()
            sdir = self.settings.sessions_dir
            # 이름 → 인스턴스 연결은 meta.json 으로만. 훅 폴더는 meta 가 가리키는 것만 읽음
            for d in sdir.iterdir() if sdir.exists() else []:
                meta = _read_json(d / "meta.json")
                if not meta or "claudeSessionId" not in meta:
                    continue
                sid = meta.get("instanceId") or meta["claudeSessionId"]
                seen.add(sid)
                hdir = self._hook_dir(meta, d)
                state = apply_interrupt(_read_json(hdir / "state.json"))
                self.db.upsert_session(meta, state, meta["tmux"] in alive)
                self._tail_events(sid, hdir / "events.jsonl")

            # 폴더가 사라진 세션 (purge 또는 같은 이름으로 새로 만듦) → 기록은 남기고 삭제 표시
            for sid in self.db.live_session_ids():
                if sid not in seen:
                    self.db.mark_deleted(sid)

            # updated_at 은 매번 바뀌니까 빼고 비교 (안 빼면 변화가 없어도 3초마다 /ws/events 푸시)
            snapshot = json.dumps(
                [{k: v for k, v in s.items() if k != "updated_at"} for s in self.db.sessions()], default=str
            )
            if snapshot != self._last_snapshot:
                self._last_snapshot = snapshot
                self.on_change()

    async def run(self) -> None:
        self.settings.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.settings.hooks_dir.mkdir(parents=True, exist_ok=True)

        # meta 는 sessions/, 훅 상태/이벤트는 hooks/ 에 있어서 둘 다 봄
        async def watch():
            async for _ in awatch(self.settings.sessions_dir, self.settings.hooks_dir, debounce=150, step=50):
                self._kick.set()

        watcher = asyncio.create_task(watch())
        try:
            while True:
                try:
                    await self.sync()
                except Exception:
                    log.exception("동기화 실패")
                # 파일 변화 없어도 tmux가 밖에서 죽는 건 주기적으로 확인
                try:
                    await asyncio.wait_for(self._kick.wait(), timeout=3)
                except asyncio.TimeoutError:
                    pass
                self._kick.clear()
        finally:
            watcher.cancel()
