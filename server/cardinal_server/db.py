"""SQLite 저장소.

세션은 이름이 아니라 세션 고유 키(instanceId)로 구분함. 같은 이름을 다시 만들면 새 행이 생기고
예전 기록은 deleted_at 찍힌 채로 남음. claude 세션 ID는 /clear 하면 바뀌어서 키로 안 씀.
"""

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,          -- 세션 고유 키 (instanceId, 예전 세션은 처음 claude 세션 ID)
  name              TEXT NOT NULL,
  role              TEXT NOT NULL,
  tmux              TEXT NOT NULL,
  cwd               TEXT NOT NULL,
  claude_args       TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  deleted_at        TEXT,                      -- 기록 폴더가 사라진 시각 (purge)
  alive             INTEGER NOT NULL DEFAULT 0,
  state             TEXT,
  state_at          TEXT,
  last_event        TEXT,
  detail            TEXT,
  tool              TEXT,
  transcript_path   TEXT,
  claude_session_id TEXT,                      -- 지금 claude 세션 ID (/clear 하면 바뀜)
  parent_id         TEXT,                      -- 이 세션을 만든 세션의 고유 키 (마스터가 띄운 워커)
  parent_name       TEXT,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_name ON sessions(name, created_at);

CREATE TABLE IF NOT EXISTS session_events (   -- 훅 이벤트 (events.jsonl 수집)
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  at          TEXT NOT NULL,
  event       TEXT NOT NULL,
  tool        TEXT,
  data        TEXT NOT NULL                     -- 원본 줄 그대로
);
CREATE INDEX IF NOT EXISTS session_events_sid ON session_events(session_id, id);

CREATE TABLE IF NOT EXISTS ingest_offsets (
  session_id  TEXT PRIMARY KEY,
  offset      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routes (           -- 어떤 채널 이벤트를 어떤 세션에 넘길지
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  platform    TEXT NOT NULL DEFAULT '*',        -- discord | local | *
  channel     TEXT,                             -- 채널 이름 또는 ID. NULL = 아무 채널
  trigger     TEXT,                             -- NULL = 모든 메시지
  match       TEXT NOT NULL DEFAULT 'prefix',   -- prefix | contains | regex | mention
  auto_reply  INTEGER NOT NULL DEFAULT 0,       -- 1이면 턴 끝나고 마지막 응답을 서버가 대신 답장
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_events (   -- 외부 채널에서 받은 메시지
  id            TEXT PRIMARY KEY,               -- evt_xxxxxxxx
  platform      TEXT NOT NULL,
  channel_id    TEXT,
  channel_name  TEXT,
  guild         TEXT,
  message_id    TEXT,
  author        TEXT,
  content       TEXT NOT NULL,
  attachments   TEXT NOT NULL DEFAULT '[]',
  received_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (       -- 이벤트 → 세션 전달 기록
  id            INTEGER PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES channel_events(id),
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  route_id      INTEGER REFERENCES routes(id),
  status        TEXT NOT NULL,                  -- pending | sent | failed
  error         TEXT,
  delivered_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS replies (          -- 세션 → 채널 답장 기록
  id            INTEGER PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES channel_events(id),
  session_id    TEXT,
  source        TEXT NOT NULL,                  -- tool (cardinal reply) | auto
  text          TEXT NOT NULL,
  files         TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL,                  -- sent | failed
  error         TEXT,
  external_ids  TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _row(r: sqlite3.Row | None) -> dict[str, Any] | None:
    if r is None:
        return None
    d = dict(r)
    for k in ("claude_args", "attachments", "files", "external_ids", "data"):
        if k in d and isinstance(d[k], str):
            d[k] = json.loads(d[k])
    for k in ("alive", "auto_reply", "enabled"):
        if k in d and d[k] is not None:
            d[k] = bool(d[k])
    return d


class DB:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        # 서버는 이벤트 루프 하나라 연결 하나 공유. 쿼리는 다 짧아서 락으로 충분
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        self._migrate()
        self.lock = threading.Lock()

    def _migrate(self) -> None:
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(sessions)")}
        if "claude_session_id" not in cols:
            self.conn.execute("ALTER TABLE sessions ADD COLUMN claude_session_id TEXT")
        for col in ("parent_id", "parent_name"):
            if col not in cols:
                self.conn.execute(f"ALTER TABLE sessions ADD COLUMN {col} TEXT")

    def q(self, sql: str, params: tuple | dict = ()) -> list[dict[str, Any]]:
        with self.lock:
            return [_row(r) for r in self.conn.execute(sql, params).fetchall()]  # type: ignore[misc]

    def one(self, sql: str, params: tuple | dict = ()) -> dict[str, Any] | None:
        rows = self.q(sql, params)
        return rows[0] if rows else None

    def exec(self, sql: str, params: tuple | dict = ()) -> int:
        with self.lock:
            return self.conn.execute(sql, params).lastrowid or 0

    # ---------- 세션 ----------

    def upsert_session(self, meta: dict, state: dict | None, alive: bool) -> None:
        s = state or {}
        # tmux가 죽었으면 훅이 못 찍었어도 ended
        st = s.get("state", "starting") if alive else "ended"
        self.exec(
            """
            INSERT INTO sessions (id, name, role, tmux, cwd, claude_args, created_at, alive,
                                  state, state_at, last_event, detail, tool, transcript_path,
                                  claude_session_id, parent_id, parent_name, updated_at)
            VALUES (:id, :name, :role, :tmux, :cwd, :args, :created, :alive,
                    :state, :state_at, :event, :detail, :tool, :transcript, :claude_sid, :parent_id, :parent_name, :now)
            ON CONFLICT(id) DO UPDATE SET
              alive=:alive, state=:state, state_at=:state_at, last_event=:event, detail=:detail,
              tool=:tool, transcript_path=COALESCE(:transcript, transcript_path),
              claude_session_id=:claude_sid, deleted_at=NULL, updated_at=:now
            """,
            {
                "id": meta.get("instanceId") or meta["claudeSessionId"],
                "name": meta["name"],
                "role": meta["role"],
                "tmux": meta["tmux"],
                "cwd": meta["cwd"],
                "args": json.dumps(meta.get("claudeArgs", [])),
                "created": meta["createdAt"],
                "alive": int(alive),
                "state": st,
                "state_at": s.get("at"),
                "event": s.get("event"),
                "detail": s.get("detail"),
                "tool": s.get("tool"),
                "transcript": s.get("transcriptPath"),
                "claude_sid": s.get("claudeSessionId") or meta["claudeSessionId"],
                "parent_id": (meta.get("parent") or {}).get("instanceId"),
                "parent_name": (meta.get("parent") or {}).get("name"),
                "now": now(),
            },
        )

    def mark_deleted(self, session_id: str) -> None:
        self.exec(
            "UPDATE sessions SET deleted_at=?, alive=0, state='ended', updated_at=? WHERE id=? AND deleted_at IS NULL",
            (now(), now(), session_id),
        )

    def live_session_ids(self) -> list[str]:
        return [r["id"] for r in self.q("SELECT id FROM sessions WHERE deleted_at IS NULL")]

    def sessions(self, include_deleted: bool = False) -> list[dict]:
        where = "" if include_deleted else "WHERE deleted_at IS NULL"
        return self.q(f"SELECT * FROM sessions {where} ORDER BY created_at")

    def session_by_name(self, name: str) -> dict | None:
        """이름으로 찾으면 가장 최근에 만든 (안 지워진) 세션"""
        return self.one(
            "SELECT * FROM sessions WHERE name=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1", (name,)
        )

    # ---------- 훅 이벤트 ----------

    def get_offset(self, session_id: str) -> int:
        r = self.one("SELECT offset FROM ingest_offsets WHERE session_id=?", (session_id,))
        return r["offset"] if r else 0

    def add_session_events(self, session_id: str, lines: list[dict], offset: int) -> None:
        with self.lock:
            self.conn.execute("BEGIN")
            try:
                self.conn.executemany(
                    "INSERT INTO session_events (session_id, at, event, tool, data) VALUES (?, ?, ?, ?, ?)",
                    [(session_id, e.get("at", now()), e.get("event", "?"), e.get("tool"), json.dumps(e)) for e in lines],
                )
                self.conn.execute(
                    "INSERT INTO ingest_offsets (session_id, offset) VALUES (?, ?)"
                    " ON CONFLICT(session_id) DO UPDATE SET offset=excluded.offset",
                    (session_id, offset),
                )
                self.conn.execute("COMMIT")
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def session_events(self, session_id: str, limit: int = 200) -> list[dict]:
        rows = self.q("SELECT * FROM session_events WHERE session_id=? ORDER BY id DESC LIMIT ?", (session_id, limit))
        return rows[::-1]

    # ---------- 라우트 ----------

    def add_route(self, session_id: str, r: dict) -> dict:
        rid = self.exec(
            "INSERT INTO routes (session_id, platform, channel, trigger, match, auto_reply, enabled, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
            (
                session_id,
                r.get("platform") or "*",
                r.get("channel"),
                r.get("trigger"),
                r.get("match") or "prefix",
                int(bool(r.get("auto_reply"))),
                now(),
            ),
        )
        return self.one("SELECT * FROM routes WHERE id=?", (rid,))  # type: ignore[return-value]

    def routes(self, session_id: str | None = None) -> list[dict]:
        if session_id:
            return self.q("SELECT * FROM routes WHERE session_id=? ORDER BY id", (session_id,))
        return self.q("SELECT * FROM routes ORDER BY id")

    def active_routes(self) -> list[dict]:
        """살아있는 세션에 붙은 켜진 라우트 + 세션 정보"""
        return self.q(
            """
            SELECT r.*, s.name AS session_name, s.state AS session_state, s.alive AS session_alive
            FROM routes r JOIN sessions s ON s.id = r.session_id
            WHERE r.enabled = 1 AND s.deleted_at IS NULL AND s.alive = 1
            ORDER BY r.id
            """
        )

    def delete_route(self, route_id: int) -> None:
        self.exec("DELETE FROM routes WHERE id=?", (route_id,))

    # ---------- 채널 이벤트 / 전달 / 답장 ----------

    def add_channel_event(self, ev: dict) -> None:
        self.exec(
            "INSERT INTO channel_events (id, platform, channel_id, channel_name, guild, message_id, author,"
            " content, attachments, received_at) VALUES (:id, :platform, :channel_id, :channel_name, :guild,"
            " :message_id, :author, :content, :attachments, :received_at)",
            {**ev, "attachments": json.dumps(ev.get("attachments", []))},
        )

    def set_event_attachments(self, event_id: str, attachments: list[dict]) -> None:
        self.exec("UPDATE channel_events SET attachments=? WHERE id=?", (json.dumps(attachments), event_id))

    def channel_event(self, event_id: str) -> dict | None:
        return self.one("SELECT * FROM channel_events WHERE id=?", (event_id,))

    def channel_events(self, limit: int = 50) -> list[dict]:
        evs = self.q("SELECT * FROM channel_events ORDER BY received_at DESC LIMIT ?", (limit,))
        for ev in evs:
            ev["deliveries"] = self.q(
                "SELECT d.*, s.name AS session_name FROM deliveries d JOIN sessions s ON s.id=d.session_id"
                " WHERE d.event_id=? ORDER BY d.id",
                (ev["id"],),
            )
            ev["replies"] = self.q("SELECT * FROM replies WHERE event_id=? ORDER BY id", (ev["id"],))
        return evs

    def add_delivery(self, event_id: str, session_id: str, route_id: int | None, status: str, error: str | None) -> None:
        self.exec(
            "INSERT INTO deliveries (event_id, session_id, route_id, status, error, delivered_at) VALUES (?, ?, ?, ?, ?, ?)",
            (event_id, session_id, route_id, status, error, now()),
        )

    def start_delivery(self, event_id: str, session_id: str, route_id: int | None) -> int:
        """전달 시작. 세션 락/idle 을 기다리는 동안은 pending"""
        return self.exec(
            "INSERT INTO deliveries (event_id, session_id, route_id, status, error, delivered_at) VALUES (?, ?, ?, 'pending', NULL, ?)",
            (event_id, session_id, route_id, now()),
        )

    def finish_delivery(self, delivery_id: int, status: str, error: str | None = None) -> None:
        self.exec("UPDATE deliveries SET status=?, error=?, delivered_at=? WHERE id=?", (status, error, now(), delivery_id))

    def was_delivered(self, event_id: str, session_id: str) -> bool:
        return bool(
            self.one("SELECT 1 FROM deliveries WHERE event_id=? AND session_id=? AND status='sent'", (event_id, session_id))
        )

    def add_reply(self, r: dict) -> dict:
        rid = self.exec(
            "INSERT INTO replies (event_id, session_id, source, text, files, status, error, external_ids, created_at)"
            " VALUES (:event_id, :session_id, :source, :text, :files, :status, :error, :external_ids, :created_at)",
            {
                **r,
                "files": json.dumps(r.get("files", [])),
                "external_ids": json.dumps(r.get("external_ids", [])),
                "created_at": now(),
            },
        )
        return self.one("SELECT * FROM replies WHERE id=?", (rid,))  # type: ignore[return-value]

    def has_reply(self, event_id: str, session_id: str | None = None) -> bool:
        """이 이벤트에 나간 답장이 있나. session_id 없으면 누가 보냈든"""
        if session_id is None:
            return bool(self.one("SELECT 1 FROM replies WHERE event_id=? AND status='sent'", (event_id,)))
        return bool(
            self.one("SELECT 1 FROM replies WHERE event_id=? AND session_id=? AND status='sent'", (event_id, session_id))
        )
