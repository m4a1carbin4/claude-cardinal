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

log = logging.getLogger("cardinal")
STATIC = Path(__file__).parent / "static"


class Hub:
    """웹소켓 구독자들한테 JSON 뿌리기"""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()

    async def publish(self, msg: dict) -> None:
        data = json.dumps(msg, default=str)
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                self.clients.discard(ws)


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

    def sessions_changed() -> None:
        asyncio.get_running_loop().create_task(
            events_hub.publish({"type": "sessions", "sessions": db.sessions()})
        )

    ingestor = Ingestor(settings, db, sessions_changed)
    router = Router(settings, db, cli, channel_hub.publish)
    local = LocalAdapter(channel_hub.publish)
    router.add_adapter(local)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await ingestor.sync()
        ingest_task = asyncio.create_task(ingestor.run())
        await local.start(router.handle)
        discord = None
        if settings.discord_token:
            from .channel.discord_adapter import DiscordAdapter

            discord = DiscordAdapter(settings.discord_token)
            router.add_adapter(discord)
            await discord.start(router.handle)
        else:
            log.info("DISCORD_TOKEN 없음 → 디스코드 채널 꺼짐 (local 채널만)")

        # cardinal reply 가 서버를 찾을 수 있게
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
            return await cli.send(name, body.text, wait=body.wait, timeout_s=body.timeout_s,
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
        out = [OutboundFile(f.filename or "file", await f.read(), f.content_type) for f in files or []]
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
