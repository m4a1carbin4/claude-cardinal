"""카디널 MCP 서버: 세션 안 모델(tmux Claude Code / SDK)이 카디널을 다루는 유일한 길.

서버가 떠 있으면 모델은 CLI 대신 이 도구들만 씀 (CLI 는 사람이 직접 개입할 때용).
- /mcp/worker: reply, session_list
- /mcp/master: 위 + 세션 만들기/보내기/기다리기/결과/정리/화면/키/질문 답하기
누가 불렀는지는 헤더로: X-Cardinal-Instance (세션 고유 키) + X-Cardinal-Key (서버 비밀 키로 만든 HMAC).
CLI 도 같은 비밀 키 파일(~/.cardinal/mcp.key)로 키를 만들어 tmux 세션에 넣어줌.
"""

import asyncio
import contextlib
import hashlib
import hmac
import json
import logging
import os
import secrets
from pathlib import Path
from typing import Any

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from .channel.base import OutboundFile
from .config import Settings
from .db import DB

log = logging.getLogger("cardinal.mcp")

MAX_REPLY_FILES = 10
MAX_REPLY_FILE_BYTES = 10 * 1024 * 1024
DEFAULT_WAIT_S = 600
MAX_WAIT_S = 3600
INSTANCE_HEADER = "x-cardinal-instance"
KEY_HEADER = "x-cardinal-key"

WORKER_INSTRUCTIONS = (
    "카디널(Cardinal) 세션 도구. `[cardinal:event <ID>]` 로 시작하는 외부 채널 이벤트에 답할 때는 응답 텍스트가 아니라 "
    "reply 도구로 보내야 전달됨."
)
MASTER_INSTRUCTIONS = WORKER_INSTRUCTIONS + (
    " 마스터는 일을 나눌 때 내장 서브 에이전트 대신 session_new 로 독립 워커 세션을 띄워 맡기고, "
    "session_send / session_wait / session_report 로 지시하고 결과를 받음."
)


def load_key(home: Path) -> bytes:
    """서버 비밀 키. 없으면 만듦 (CLI 도 이 파일을 읽어 tmux 세션용 키를 만듦)"""
    path = home / "mcp.key"
    with contextlib.suppress(FileNotFoundError):
        k = path.read_text().strip()
        if k:
            return k.encode()
    home.mkdir(parents=True, exist_ok=True)
    k = secrets.token_hex(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(k)
    return k.encode()


def session_key(secret: bytes, instance_id: str) -> str:
    # src/session.ts mcpAttach 와 같은 계산
    return hmac.new(secret, instance_id.encode(), hashlib.sha256).hexdigest()


def mcp_config(settings: Settings, secret: bytes, instance_id: str, role: str) -> dict:
    """세션에 붙일 MCP 서버 설정 (SDK mcp_servers / claude --mcp-config 의 한 항목)"""
    return {
        "type": "http",
        "url": f"{settings.url}/mcp/{'master' if role == 'master' else 'worker'}",
        "headers": {"X-Cardinal-Instance": instance_id, "X-Cardinal-Key": session_key(secret, instance_id)},
    }


def _json(x: Any) -> str:
    return json.dumps(x, ensure_ascii=False, indent=1, default=str)


class CardinalMcp:
    def __init__(self, settings: Settings, db: DB, sessions: Any, router: Any, ingestor: Any):
        self.settings = settings
        self.db = db
        self.sessions = sessions  # sessions.Sessions
        self.router = router
        self.ingestor = ingestor
        self.secret = load_key(settings.home)
        self.worker = MCPServer("cardinal", instructions=WORKER_INSTRUCTIONS)
        self.master = MCPServer("cardinal", instructions=MASTER_INSTRUCTIONS)
        self._register()
        # stateless: 서버가 재시작돼도 세션 쪽 MCP 연결 상태가 안 꼬임 (요청마다 독립)
        self.worker_app = self._guard(self.worker.streamable_http_app(streamable_http_path="/", stateless_http=True),
                                      master_only=False)
        self.master_app = self._guard(self.master.streamable_http_app(streamable_http_path="/", stateless_http=True),
                                      master_only=True)

    async def app(self, scope, receive, send):
        """/mcp 에 붙는 ASGI 앱. /mcp/worker, /mcp/master (끝 / 있어도 없어도) → 각 MCP 서버의 / 로"""
        rest = scope["path"][len(scope.get("root_path", "")):] if scope["path"].startswith(scope.get("root_path", "")) else scope["path"]
        target = {"worker": self.worker_app, "master": self.master_app}.get(rest.strip("/").removeprefix("mcp/"))
        if target is None or scope["type"] not in ("http", "websocket"):
            if scope["type"] == "http":
                await send({"type": "http.response.start", "status": 404, "headers": [(b"content-type", b"text/plain")]})
                await send({"type": "http.response.body", "body": b"cardinal mcp: /mcp/worker or /mcp/master"})
            return
        await target({**scope, "path": "/", "raw_path": b"/", "root_path": ""}, receive, send)

    @contextlib.asynccontextmanager
    async def run(self):
        async with self.worker.session_manager.run(), self.master.session_manager.run():
            yield

    # ---------- 인증 ----------

    async def _caller_row(self, instance_id: str | None, key: str | None) -> dict | None:
        if not instance_id or not key or not hmac.compare_digest(key, session_key(self.secret, instance_id)):
            return None
        row = self.db.session_by_id(instance_id)
        if row is None:
            # 막 뜬 tmux 세션은 수집기가 아직 DB 에 안 넣었을 수 있음
            await self.ingestor.sync()
            row = self.db.session_by_id(instance_id)
        return row if row and not row.get("deleted_at") else None

    def _guard(self, app, master_only: bool):
        async def asgi(scope, receive, send):
            if scope["type"] == "http" and scope["method"] == "GET":
                # 서버 → 세션 알림 스트림(GET SSE)은 안 씀. 열어두게 하면 클라이언트(claude)가 연결을 계속 잡고 있어서
                # uvicorn 이 종료 때 그 연결을 기다리다 SDK 세션 정리(lifespan)까지 못 감 (실측: 종료가 안 끝남)
                await send({"type": "http.response.start", "status": 405,
                            "headers": [(b"allow", b"POST, DELETE"), (b"content-type", b"text/plain")]})
                await send({"type": "http.response.body", "body": b"cardinal mcp: no server-initiated stream"})
                return
            if scope["type"] == "http":
                h = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
                row = await self._caller_row(h.get(INSTANCE_HEADER), h.get(KEY_HEADER))
                if row is None or (master_only and row["role"] != "master"):
                    status = 401 if row is None else 403
                    body = b"cardinal mcp: unknown session" if row is None else b"cardinal mcp: master only"
                    await send({"type": "http.response.start", "status": status,
                                "headers": [(b"content-type", b"text/plain")]})
                    await send({"type": "http.response.body", "body": body})
                    return
            await app(scope, receive, send)

        return asgi

    def _caller(self, ctx: Context) -> dict:
        h = ctx.headers or {}
        row = self.db.session_by_id(h.get(INSTANCE_HEADER, ""))
        if not row:
            raise ToolError("부른 세션을 모름")
        return row

    # ---------- 도구 ----------

    def _register(self) -> None:
        for srv in (self.worker, self.master):
            srv.add_tool(self.reply, name="reply", description=(
                "외부 채널 이벤트([cardinal:event <ID>])에 답장. 응답 텍스트만으로는 전달되지 않으니 반드시 이걸로 보냄. "
                "files: 첨부할 로컬 파일 경로 (작업 폴더 기준 상대 경로 가능, 최대 10개·각 10MB)"))
            srv.add_tool(self.session_list, name="session_list",
                         description="카디널 세션 목록과 상태 (이름, 역할, 방식, 상태, 작업 폴더, 만든 세션)")
        m = self.master
        m.add_tool(self.session_new, name="session_new", description=(
            "독립 워커 세션 만들기 (내장 서브 에이전트 대신). cwd 를 안 주면 너와 같은 작업 폴더, backend 를 안 주면 너와 같은 방식. "
            "prompt 를 주면 바로 첫 지시를 보내고, wait=true 면 그 턴의 응답까지 기다려 돌려줌"))
        m.add_tool(self.session_send, name="session_send", description=(
            "세션에 지시 보내기. 작업 중이면 끝난 뒤 차례로 들어감. wait=true(기본)면 그 턴의 응답(last)까지 기다림. "
            "오래 걸릴 일은 wait=false 로 보내고 session_wait 로 기다려도 됨"))
        m.add_tool(self.session_wait, name="session_wait", description=(
            "세션이 지금 하는 일을 끝낼 때까지 기다린 뒤 결과 보고를 돌려줌 (질문/권한 대기에 걸리면 바로 돌려줌)"))
        m.add_tool(self.session_report, name="session_report", description=(
            "세션 결과 보고: 살아있는지, 작업중/완료/중단, 마지막 사람 턴의 지시와 응답 전체, 답 기다리는 질문(SDK)"))
        m.add_tool(self.session_kill, name="session_kill",
                   description="세션 끝내기 (purge=true 면 기록도 삭제 표시)")
        m.add_tool(self.session_screen, name="session_screen", description=(
            "tmux 세션의 지금 화면 텍스트 (승인 다이얼로그 등 확인용). lines 로 스크롤백 추가"))
        m.add_tool(self.session_keys, name="session_keys", description=(
            "tmux 세션에 키 보내기 (예: [\"Down\", \"Enter\"], [\"Escape\"]). 승인 다이얼로그 처리용"))
        m.add_tool(self.session_answer, name="session_answer", description=(
            "SDK 세션의 질문/권한 확인에 답하기 (session_report 의 pending 참고). "
            "질문: answers={질문 텍스트: 고른 답}. 권한: allow=true/false (+ message)"))

    async def reply(self, event_id: str, text: str = "", files: list[str] | None = None, ctx: Context = None) -> str:
        me = self._caller(ctx)
        files = files or []
        if len(files) > MAX_REPLY_FILES:
            raise ToolError(f"첨부는 최대 {MAX_REPLY_FILES}개")
        out = []
        for f in files:
            p = Path(f) if os.path.isabs(f) else Path(me["cwd"]) / f
            try:
                if p.stat().st_size > MAX_REPLY_FILE_BYTES:
                    raise ToolError(f"파일이 너무 큼 (> 10MB): {p}")
                out.append(OutboundFile(p.name, p.read_bytes(), None))
            except OSError as e:
                raise ToolError(f"파일을 못 읽음: {p} ({e})")
        if not text.strip() and not out:
            raise ToolError("보낼 텍스트나 파일이 필요")
        try:
            saved = await self.router.reply(event_id, me["name"], text, out)
        except Exception as e:
            raise ToolError(f"답장 실패: {e}")
        return f"답장 보냄 (reply {saved['id']})"

    async def session_list(self, ctx: Context = None) -> str:
        self._caller(ctx)
        rows = [{k: s[k] for k in ("name", "role", "backend", "state", "alive", "cwd", "parent_name")}
                for s in self.db.sessions()]
        return _json(rows)

    def _not_self(self, me: dict, name: str, what: str) -> None:
        if name == me["name"]:
            raise ToolError(f"자기 자신에게는 {what} 못 함")

    async def session_new(self, name: str, prompt: str | None = None, role: str = "worker", cwd: str | None = None,
                          backend: str | None = None, wait: bool = False, timeout_s: int = DEFAULT_WAIT_S,
                          ctx: Context = None) -> str:
        me = self._caller(ctx)
        if role not in ("worker", "master"):
            raise ToolError("role 은 worker 또는 master")
        try:
            row = await self.sessions.create(
                name=name, role=role, prompt=None, cwd=cwd or me["cwd"], backend=backend or me["backend"],
                parent={"id": me["id"], "name": me["name"]}, trust=True)
            out: dict[str, Any] = {"created": row.get("name"), "backend": row.get("backend"), "cwd": row.get("cwd")}
            if prompt:
                out["send"] = await self.sessions.send(name, prompt, wait=wait, timeout_s=min(timeout_s, MAX_WAIT_S))
        except ToolError:
            raise
        except Exception as e:
            raise ToolError(f"실패: {e}")
        return _json(out)

    async def session_send(self, name: str, text: str, wait: bool = True, timeout_s: int = DEFAULT_WAIT_S,
                           now: bool = False, ctx: Context = None) -> str:
        me = self._caller(ctx)
        self._not_self(me, name, "보내기")
        try:
            res = await self.sessions.send(name, text, wait=wait, timeout_s=min(timeout_s, MAX_WAIT_S), now=now)
        except Exception as e:
            raise ToolError(f"실패: {e}")
        return _json(res)

    async def session_wait(self, name: str, timeout_s: int = DEFAULT_WAIT_S, ctx: Context = None) -> str:
        me = self._caller(ctx)
        self._not_self(me, name, "기다리기")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + min(timeout_s, MAX_WAIT_S)
        while True:
            try:
                rep = await self.sessions.report(name)
            except Exception as e:
                raise ToolError(f"실패: {e}")
            if rep.get("phase") not in ("working", "starting") or rep.get("pending"):
                return _json(rep)
            if loop.time() >= deadline:
                return _json({**rep, "timedOut": True})
            await asyncio.sleep(1.5)

    async def session_report(self, name: str, ctx: Context = None) -> str:
        self._caller(ctx)
        try:
            return _json(await self.sessions.report(name))
        except Exception as e:
            raise ToolError(f"실패: {e}")

    async def session_kill(self, name: str, purge: bool = False, ctx: Context = None) -> str:
        me = self._caller(ctx)
        self._not_self(me, name, "kill")
        try:
            await self.sessions.kill(name, purge)
        except Exception as e:
            raise ToolError(f"실패: {e}")
        return "끝냄"

    def _tmux_only(self, name: str) -> None:
        row = self.db.session_by_name(name)
        if not row:
            raise ToolError(f"모르는 세션: {name}")
        if row["backend"] != "tmux":
            raise ToolError(f"tmux 세션만: {name} 은 SDK 세션 (session_report / session_answer 사용)")

    async def session_screen(self, name: str, lines: int = 0, ctx: Context = None) -> str:
        self._caller(ctx)
        self._tmux_only(name)
        try:
            return await self.sessions.cli.run("screen", name, "--lines", str(max(0, lines)))
        except Exception as e:
            raise ToolError(f"실패: {e}")

    async def session_keys(self, name: str, keys: list[str], ctx: Context = None) -> str:
        me = self._caller(ctx)
        self._not_self(me, name, "키 보내기")
        self._tmux_only(name)
        try:
            await self.sessions.cli.run("keys", name, *keys)
        except Exception as e:
            raise ToolError(f"실패: {e}")
        return "보냄"

    async def session_answer(self, name: str, pending_id: str, answers: dict[str, str] | None = None,
                             allow: bool = True, message: str | None = None, ctx: Context = None) -> str:
        self._caller(ctx)
        try:
            return _json(self.sessions.sdk_session(name).answer(pending_id, answers, allow, message, None))
        except Exception as e:
            raise ToolError(f"실패: {e}")
