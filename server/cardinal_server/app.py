"""카디널 서버 (FastAPI).

- 세션 제어: cardinal CLI 호출 (로직은 CLI 한 곳)
- 세션 기록: ~/.cardinal 파일 → SQLite 수집
- 웹 터미널: /ws/term/<이름>
- 메시지 채널: 디스코드(DISCORD_TOKEN 있으면) + local, 라우트 따라 세션에 전달, cardinal reply 로 답장
"""

import asyncio
import base64
import contextlib
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import terminal
from .channel.base import InboundAttachment, InboundMessage, OutboundFile
from .channel.local_adapter import LocalAdapter
from .cli import Cli, CliError
from .config import Settings, load
from .db import DB
from .ingest import Ingestor
from .router import Router
from .running import running_elsewhere

log = logging.getLogger("cardinal")
STATIC = Path(__file__).parent / "static"

# 답장 API 서버 쪽 한도 (CLI 도 같은 값으로 미리 검사함, 디스코드 무부스트 서버 기준)
MAX_REPLY_FILES = 10
MAX_REPLY_FILE_BYTES = 10 * 1024 * 1024
# /send 에 wait 만 주고 timeout_s 를 안 주면 이만큼만 기다림 (세션이 멈추면 요청이 영원히 안 끝나니까)
DEFAULT_WAIT_TIMEOUT_S = 900
# 구독자 하나에 보내는 데 이보다 오래 걸리면 끊음 (느린 클라이언트가 전달 흐름을 붙잡지 않게)
PUBLISH_TIMEOUT_S = 2.0


class _RedactToken(logging.Filter):
    """uvicorn 접근 로그의 ?token=xxx 를 가림"""

    pattern = re.compile(r"(token=)[^&\s\"']+")

    def _sub(self, v):
        return self.pattern.sub(r"\1***", v) if isinstance(v, str) else v

    def filter(self, record: logging.LogRecord) -> bool:
        # 접근 로그 포매터는 record.args 튜플을 풀어서 쓰니까 구조는 그대로 두고 값만 바꿈
        if isinstance(record.args, tuple):
            record.args = tuple(self._sub(a) for a in record.args)
        record.msg = self._sub(record.msg)
        return True


class Hub:
    """웹소켓 구독자들한테 JSON 뿌리기"""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()

    async def _send(self, ws: WebSocket, data: str) -> None:
        try:
            await asyncio.wait_for(ws.send_text(data), PUBLISH_TIMEOUT_S)
        except Exception:
            # 끊겼거나 너무 느림 → 구독 해제
            self.clients.discard(ws)
            with contextlib.suppress(Exception):
                await ws.close()

    async def publish(self, msg: dict) -> None:
        # 구독자별로 동시에, 각자 시간 제한. 하나가 느려도 나머지와 호출한 쪽(라우터)은 안 막힘
        data = json.dumps(msg, default=str)
        await asyncio.gather(*(self._send(ws, data) for ws in list(self.clients)))


# ---------- 요청 모델 ----------


class RouteIn(BaseModel):
    platform: Literal["discord", "local", "*"] = "*"
    channel: str | None = None  # 채널 이름 또는 ID. 없으면 아무 채널
    trigger: str | None = None  # 없으면 모든 메시지
    match: Literal["prefix", "contains", "regex", "mention"] = "prefix"
    auto_reply: bool = False


class SessionIn(BaseModel):
    name: str
    role: Literal["worker", "master"] = "worker"
    prompt: str | None = None
    args: list[str] = Field(default_factory=list)
    routes: list[RouteIn] = Field(default_factory=list)


class SendIn(BaseModel):
    text: str
    wait: bool = False
    timeout_s: int | None = None
    submit: bool = True
    force: bool = False
    now: bool = False  # 작업 중이어도 안 기다리고 바로 (진행 중인 턴에 끼어듦)


class KeysIn(BaseModel):
    keys: list[str]


class InboundIn(BaseModel):
    """local 채널로 메시지 넣기 (테스트/웹훅용)"""

    content: str
    channel: str = "local"
    author: str = "local"
    mentions_bot: bool = False


# ---------- 앱 ----------


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load()
    db = DB(settings.db_path)
    cli = Cli(settings)
    events_hub, channel_hub = Hub(), Hub()
    # 만들고 참조를 안 들고 있으면 태스크가 끝나기 전에 GC 로 사라질 수 있음
    bg_tasks: set[asyncio.Task] = set()

    def sessions_changed() -> None:
        t = asyncio.get_running_loop().create_task(
            events_hub.publish({"type": "sessions", "sessions": db.sessions()})
        )
        bg_tasks.add(t)
        t.add_done_callback(bg_tasks.discard)

    ingestor = Ingestor(settings, db, sessions_changed)
    router = Router(settings, db, cli, channel_hub.publish)
    local = LocalAdapter(channel_hub.publish)
    router.add_adapter(local)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # uvicorn 이 로깅 설정을 끝낸 뒤라 여기서 붙임
        for name in ("uvicorn.access", "uvicorn.error"):
            logging.getLogger(name).addFilter(_RedactToken())
        await ingestor.sync()
        ingest_task = asyncio.create_task(ingestor.run())
        await local.start(router.handle)
        discord = None
        app.state.discord = None
        if settings.discord_token:
            from .channel.discord_adapter import DiscordAdapter

            discord = DiscordAdapter(settings.discord_token)
            app.state.discord = discord
            router.add_adapter(discord)
            await discord.start(router.handle)
        else:
            log.info("DISCORD_TOKEN 없음 → 디스코드 채널 꺼짐 (local 채널만)")

        # cardinal reply 가 서버를 찾을 수 있게
        # 사전 확인과 여기 사이에 다른 서버가 떴을 수도 있으니 덮어쓰기 직전에 한 번 더
        if reason := running_elsewhere(settings):
            raise RuntimeError(f"시작 안 함 — {reason}")
        info = settings.home / "server.json"
        info.write_text(json.dumps({"url": settings.url, "token": settings.token, "pid": os.getpid()}))
        info.chmod(0o600)
        try:
            yield
        finally:
            with contextlib.suppress(FileNotFoundError):
                if json.loads(info.read_text()).get("pid") == os.getpid():
                    info.unlink()
            ingest_task.cancel()
            if discord:
                await discord.stop()

    app = FastAPI(title="Cardinal", lifespan=lifespan)
    app.state.settings, app.state.db, app.state.router = settings, db, router

    # ---------- 인증 ----------

    def token_ok(query_token: str | None, auth_header: str | None) -> bool:
        return not settings.token or query_token == settings.token or auth_header == f"Bearer {settings.token}"

    def auth(request: Request) -> None:
        if not token_ok(request.query_params.get("token"), request.headers.get("authorization")):
            raise HTTPException(401, "unauthorized")

    async def ws_auth(ws: WebSocket) -> bool:
        if token_ok(ws.query_params.get("token"), ws.headers.get("authorization")):
            return True
        await ws.close(code=4401, reason="unauthorized")
        return False

    def cli_call(e: CliError) -> HTTPException:
        return HTTPException(400, str(e))

    def session_or_404(name: str) -> dict:
        s = db.session_by_name(name)
        if not s:
            raise HTTPException(404, f"모르는 세션: {name}")
        return s

    api = [Depends(auth)]

    # ---------- 페이지 ----------

    @app.get("/", dependencies=api)
    async def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/api/health", dependencies=api)
    async def health():
        d = app.state.discord
        return {
            "ok": True,
            "channels": {"local": "ready", "discord": d.status if d else "off"},
            "sessions": len(db.sessions()),
        }

    # ---------- 세션 ----------

    @app.get("/api/sessions", dependencies=api)
    async def list_sessions(all: bool = False):
        return db.sessions(include_deleted=all)

    @app.post("/api/sessions", status_code=201, dependencies=api)
    async def create_session(body: SessionIn):
        try:
            st = await cli.new(body.name, body.role, body.prompt, body.args)
        except CliError as e:
            raise cli_call(e)
        await ingestor.sync()
        sid = st.get("instanceId") or st["claudeSessionId"]
        routes = [db.add_route(sid, r.model_dump()) for r in body.routes]
        return {**(db.session_by_name(body.name) or {}), "routes": routes}

    @app.get("/api/sessions/{name}", dependencies=api)
    async def get_session(name: str):
        s = session_or_404(name)
        return {**s, "routes": db.routes(s["id"])}

    @app.delete("/api/sessions/{name}", dependencies=api)
    async def delete_session(name: str, purge: bool = False):
        try:
            await cli.run("kill", name, *(["--purge"] if purge else []))
        except CliError as e:
            raise cli_call(e)
        await ingestor.sync()
        return {"ok": True}

    @app.post("/api/sessions/{name}/send", dependencies=api)
    async def send(name: str, body: SendIn):
        try:
            timeout_s = body.timeout_s or (DEFAULT_WAIT_TIMEOUT_S if body.wait else None)
            return await cli.send(name, body.text, wait=body.wait, timeout_s=timeout_s,
                                  submit=body.submit, force=body.force, now=body.now)
        except CliError as e:
            raise cli_call(e)

    @app.post("/api/sessions/{name}/keys", dependencies=api)
    async def keys(name: str, body: KeysIn):
        try:
            await cli.run("keys", name, *body.keys)
        except CliError as e:
            raise cli_call(e)
        return {"ok": True}

    @app.get("/api/sessions/{name}/screen", dependencies=api)
    async def screen(name: str, lines: int = 0):
        try:
            return {"screen": await cli.run("screen", name, "--lines", str(lines))}
        except CliError as e:
            raise cli_call(e)

    @app.get("/api/sessions/{name}/report", dependencies=api)
    async def report(name: str):
        try:
            return await cli.json("report", name)
        except CliError as e:
            raise cli_call(e)

    @app.get("/api/sessions/{name}/events", dependencies=api)
    async def session_events(name: str, limit: int = 200):
        return db.session_events(session_or_404(name)["id"], limit)

    # ---------- 라우트 ----------

    @app.get("/api/sessions/{name}/routes", dependencies=api)
    async def list_routes(name: str):
        return db.routes(session_or_404(name)["id"])

    @app.post("/api/sessions/{name}/routes", status_code=201, dependencies=api)
    async def add_route(name: str, body: RouteIn):
        return db.add_route(session_or_404(name)["id"], body.model_dump())

    @app.delete("/api/routes/{route_id}", dependencies=api)
    async def delete_route(route_id: int):
        db.delete_route(route_id)
        return {"ok": True}

    # ---------- 채널 ----------

    @app.get("/api/events", dependencies=api)
    async def channel_events(limit: int = 50):
        return db.channel_events(limit)

    @app.post("/api/channel/inbound", dependencies=api)
    async def inbound(body: InboundIn):
        return await router.handle(
            InboundMessage(platform="local", content=body.content, channel_id=body.channel,
                           channel_name=body.channel, author=body.author, mentions_bot=body.mentions_bot)
        )

    @app.post("/api/events/{event_id}/reply", dependencies=api)
    async def reply(event_id: str, text: str = Form(""), session: str = Form(""),
                    files: list[UploadFile] | None = File(None)):
        files = files or []
        if not text.strip() and not files:
            raise HTTPException(400, "보낼 텍스트나 파일이 필요")
        if len(files) > MAX_REPLY_FILES:
            raise HTTPException(413, f"첨부는 최대 {MAX_REPLY_FILES}개")
        out = []
        for f in files:
            # 한도 + 1 바이트까지만 읽어서 넘는지 판단 (큰 파일을 통째로 메모리에 안 올림)
            data = await f.read(MAX_REPLY_FILE_BYTES + 1)
            if len(data) > MAX_REPLY_FILE_BYTES:
                raise HTTPException(413, f"파일이 너무 큼 (> 10MB): {f.filename}")
            out.append(OutboundFile(f.filename or "file", data, f.content_type))
        try:
            return await router.reply(event_id, session or None, text, out)
        except LookupError as e:
            raise HTTPException(404, str(e))
        except RuntimeError as e:
            raise HTTPException(502, str(e))

    # ---------- 웹소켓 ----------

    @app.websocket("/ws/term/{name}")
    async def ws_term(ws: WebSocket, name: str, cols: int = 120, rows: int = 40, readonly: int = 0):
        if not await ws_auth(ws):
            return
        s = db.session_by_name(name)
        if not s or not s["alive"]:
            await ws.close(code=4404, reason="unknown or dead session")
            return
        await ws.accept()
        await terminal.bridge(ws, s["tmux"], cols, rows, bool(readonly))

    async def subscribe(ws: WebSocket, hub: Hub, hello: dict[str, Any] | None, on_text=None) -> None:
        await ws.accept()
        hub.clients.add(ws)
        try:
            if hello:
                await ws.send_text(json.dumps(hello, default=str))
            while True:
                raw = await ws.receive_text()
                if on_text:
                    await on_text(raw)
        except WebSocketDisconnect:
            pass
        finally:
            hub.clients.discard(ws)

    @app.websocket("/ws/events")
    async def ws_events(ws: WebSocket):
        if await ws_auth(ws):
            await subscribe(ws, events_hub, {"type": "sessions", "sessions": db.sessions()})

    @app.websocket("/ws/channel")
    async def ws_channel(ws: WebSocket):
        """채널 이벤트/답장 구독. local 채널 메시지 넣기도 가능:
        {"type":"message","content":..,"channel":..,"attachments":[{"filename":..,"data":<base64>}]}"""
        if not await ws_auth(ws):
            return

        async def on_text(raw: str) -> None:
            try:
                m = json.loads(raw)
            except ValueError:
                return
            if m.get("type") == "message" and m.get("content"):
                await router.handle(
                    InboundMessage(platform="local", content=m["content"], channel_id=m.get("channel", "local"),
                                   channel_name=m.get("channel", "local"), author=m.get("author", "local"),
                                   mentions_bot=bool(m.get("mentions_bot")),
                                   attachments=[InboundAttachment(filename=a["filename"], data=base64.b64decode(a["data"]))
                                                for a in m.get("attachments", []) if "filename" in a and "data" in a])
                )

        await subscribe(ws, channel_hub, None, on_text)

    return app
