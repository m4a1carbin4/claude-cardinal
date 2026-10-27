"""카디널 서버 (FastAPI).

- 세션 제어: cardinal CLI 호출 (로직은 CLI 한 곳)
- 세션 기록: ~/.cardinal 파일 → SQLite 수집
- 웹 터미널: /ws/term/<이름>
- 메시지 채널: 디스코드(DISCORD_TOKEN 있으면) + local, 라우트 따라 세션에 전달, cardinal reply 로 답장
- SDK 모드(--sdk): tmux 없이 서버 안에서 Claude Agent SDK 세션을 돌림 (backend=sdk). 채널·라우트는 같이 씀
- 웹드라이브: 사람과 세션이 같이 쓰는 파일 공간 (/api/drive, 세션마다 /sessions/<이름>, drive.py)
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
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

from . import terminal
from .channel.base import InboundAttachment, InboundMessage, OutboundFile
from .channel.local_adapter import LocalAdapter
from .cli import Cli, CliError
from .config import REPO_ROOT, Settings, load
from .db import DB
from .drive import ATTACHMENTS, Drive, DriveError
from .ingest import Ingestor
from .router import Router
from .running import running_elsewhere
from .mcp_server import CardinalMcp
from .sdk import SdkError, SdkManager, redact_options, unredact
from .sessions import SessionError, Sessions

log = logging.getLogger("cardinal")
# 웹 UI (web/, Vite + React) 빌드 결과. cd web && pnpm install && pnpm build
WEB_DIST = Path(os.environ.get("CARDINAL_WEB_DIST", REPO_ROOT / "web" / "dist")).resolve()

NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>Cardinal</title>
<body style="font-family:system-ui;max-width:560px;margin:60px auto;padding:0 16px;line-height:1.6">
<h1>웹 UI가 아직 빌드되지 않았음</h1>
<p>저장소에서 아래를 실행한 뒤 새로고침하세요. 서버는 재시작할 필요 없음.</p>
<pre style="background:#eee;padding:12px;border-radius:8px">cd web
pnpm install
pnpm build</pre>
<p>개발 중이면 <code>cd web &amp;&amp; pnpm dev</code> (API/웹소켓은 이 서버로 프록시).</p>
<p>API는 그대로 쓸 수 있음: <code>/api/health</code></p></body>"""

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


PermissionModeT = Literal["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions", "auto"]


class SdkOptionsIn(BaseModel):
    """backend=sdk 세션 설정 (ClaudeAgentOptions 로 바뀜). restart 때 일부만 바꿔 다시 쓸 수 있음"""

    permission_mode: PermissionModeT = "auto"
    model: str | None = None
    fallback_model: str | None = None
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    append_prompt: str | None = None  # 카디널 역할 프롬프트 뒤에 붙일 시스템 프롬프트
    # 외부 MCP 서버: {"이름": {"type": "stdio", "command": ..., "args": [...], "env": {...}}
    #                         | {"type": "http"|"sse", "url": ..., "headers": {...}}}
    mcp_servers: dict[str, dict[str, Any]] = Field(default_factory=dict)
    # True 면 위 mcp_servers(+ cardinal)만 씀. 사용자 설정/프로젝트 .mcp.json/claude.ai 커넥터/플러그인 MCP 는 안 붙음
    strict_mcp_config: bool = False
    allowed_tools: list[str] = Field(default_factory=list)
    disallowed_tools: list[str] = Field(default_factory=list)
    add_dirs: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    partial: bool = False  # 토큰 단위 스트리밍 이벤트(StreamEvent)를 /ws/sdk 로 (음성 합성 등)
    max_turns: int | None = None
    max_budget_usd: float | None = None
    setting_sources: list[Literal["user", "project", "local"]] | None = None
    question_timeout_s: int | None = None  # 질문/권한에 이 시간 안에 답이 없으면 "스스로 판단" 으로 돌려줌
    resume_on_start: bool = False  # 서버가 다시 뜰 때 이 세션을 이어서 자동으로 띄움
    # Claude in Chrome (브라우저 조작 MCP). None 이면 ~/.claude.json 의 claudeInChromeDefaultEnabled 를 따름
    # (터미널 claude 는 그 값을 보지만 SDK 의 비대화 모드는 안 봐서 --chrome 을 직접 붙여야 함)
    chrome: bool | None = None


def check_sdk_options(o: SdkOptionsIn) -> dict:
    for name, srv in o.mcp_servers.items():
        if name == "cardinal":
            raise HTTPException(400, "mcp_servers 의 cardinal 은 카디널 도구용 예약 이름")
        kind = srv.get("type", "stdio")
        if kind == "stdio" and not srv.get("command"):
            raise HTTPException(400, f"MCP {name}: stdio 는 command 필요")
        if kind in ("http", "sse") and not srv.get("url"):
            raise HTTPException(400, f"MCP {name}: {kind} 는 url 필요")
        if kind not in ("stdio", "http", "sse"):
            raise HTTPException(400, f"MCP {name}: 모르는 type {kind}")
    for d in o.add_dirs:
        if not os.path.isabs(d):
            raise HTTPException(400, f"add_dirs 는 절대 경로: {d}")
    return o.model_dump()


class SessionIn(BaseModel):
    name: str
    role: Literal["worker", "master"] = "worker"
    prompt: str | None = None
    cwd: str | None = None  # 세션 작업 폴더 (절대 경로). 없으면 고정 워크스페이스
    trust: bool = False  # 작업 폴더 신뢰 다이얼로그 자동 수락 (tmux)
    args: list[str] = Field(default_factory=list)  # claude 추가 인자 (tmux)
    routes: list[RouteIn] = Field(default_factory=list)
    backend: Literal["tmux", "sdk"] | None = None  # 없으면 서버 기본 (--sdk 면 sdk)
    sdk: SdkOptionsIn | None = None


class RestartIn(BaseModel):
    resume: bool = True  # False 면 새 대화로
    sdk: dict[str, Any] | None = None  # 바꿀 sdk 옵션만 (나머지는 그대로). env/헤더 값이 *** 면 원래 값 유지


class AnswerIn(BaseModel):
    answers: dict[str, str] | None = None  # 질문: {질문 텍스트: 고른 답(라벨 또는 자유 입력)}
    allow: bool = True  # 권한: 허용/거부. 질문에서 False 면 "답 안 함" 으로 돌려줌
    message: str | None = None  # 거부 사유 (claude 에 전달)
    updated_input: dict[str, Any] | None = None  # 권한 허용 시 도구 입력을 바꿔서


class McpActionIn(BaseModel):
    action: Literal["reconnect", "enable", "disable"]


class ModelIn(BaseModel):
    model: str | None = None  # None 이면 기본 모델


class ModeIn(BaseModel):
    mode: PermissionModeT


class SendIn(BaseModel):
    text: str
    attachments: list[str] = Field(default_factory=list)  # 웹드라이브 경로. 지시 뒤에 첨부 안내(로컬 경로 포함)가 붙음
    wait: bool = False
    timeout_s: int | None = None
    submit: bool = True
    force: bool = False
    now: bool = False  # 작업 중이어도 안 기다리고 바로 (진행 중인 턴에 끼어듦)


class DrivePathIn(BaseModel):
    path: str


class DriveTextIn(BaseModel):
    path: str
    content: str
    overwrite: bool = True  # False 면 새 파일만 (있으면 400)


class DriveMoveIn(BaseModel):
    src: str
    dst: str  # 있는 폴더면 그 안으로, 아니면 새 이름
    overwrite: bool = False


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

    def bg(coro) -> None:
        t = asyncio.get_running_loop().create_task(coro)
        bg_tasks.add(t)
        t.add_done_callback(bg_tasks.discard)

    main_loop: list[asyncio.AbstractEventLoop] = []

    def drive_changed(path: str) -> None:
        # MCP 도구는 파일 작업을 스레드에서 해서 거기서 불릴 수도 있음 → 서버 루프로 넘김
        publish = lambda: bg(events_hub.publish({"type": "drive", "path": path}))  # noqa: E731
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            if main_loop:
                main_loop[0].call_soon_threadsafe(publish)
            return
        publish()

    # 웹드라이브. 파일이 바뀌면 웹 UI 가 그 폴더를 다시 읽게 알림
    drive = Drive(settings.drive, settings.drive_max_upload, drive_changed)

    def ensure_drive_dirs() -> None:
        # 모든 세션은 자기 드라이브 폴더가 있음 (CLI 로 직접 만든 세션도 수집되면 여기서 생김)
        for row in db.sessions():
            with contextlib.suppress(OSError, DriveError):
                drive.ensure_session(row["name"])

    def sessions_changed() -> None:
        ensure_drive_dirs()
        bg(events_hub.publish({"type": "sessions", "sessions": [pub(x) for x in db.sessions()]}))

    ingestor = Ingestor(settings, db, sessions_changed)
    # sdk 세션 기록 정리(지난 서버가 남긴 것)는 SDK 모드가 꺼져 있어도 함. 새로 만들기는 --sdk 일 때만
    sdk_mgr = SdkManager(settings, db, sessions_changed)
    sessions = Sessions(settings, db, cli, ingestor, sdk_mgr, drive)
    router = Router(settings, db, sessions, channel_hub.publish)
    sdk_mgr.router, sdk_mgr.facade = router, sessions
    # 세션 안 모델이 카디널을 다루는 MCP (tmux·SDK 공통). SDK 세션은 여기 주소와 키로 붙음
    cmcp = CardinalMcp(settings, db, sessions, router, ingestor, drive)
    sdk_mgr.mcp_secret = cmcp.secret
    local = LocalAdapter(channel_hub.publish)
    router.add_adapter(local)

    async def reconnect_tmux_mcp() -> None:
        rows = [r for r in db.sessions() if r["backend"] == "tmux" and r["alive"] and r.get("mcp")]
        if not rows:
            return
        await sdk_mgr.wait_serving()

        async def one(name: str) -> None:
            try:
                # 작업 중이면 끝날 때까지 기다렸다가 침 (send 와 같은 줄)
                await cli.run("mcp-reconnect", name, timeout=700)
                log.info("카디널 MCP 다시 붙임: %s", name)
            except CliError as e:
                log.warning("카디널 MCP 다시 붙이기 실패: %s (%s)", name, e)

        await asyncio.gather(*(one(r["name"]) for r in rows))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # uvicorn 이 로깅 설정을 끝낸 뒤라 여기서 붙임
        for name in ("uvicorn.access", "uvicorn.error"):
            logging.getLogger(name).addFilter(_RedactToken())
        main_loop.append(asyncio.get_running_loop())
        await ingestor.sync()
        ensure_drive_dirs()
        await sdk_mgr.startup()
        ingest_task = asyncio.create_task(ingestor.run())
        mcp_ctx = cmcp.run()
        await mcp_ctx.__aenter__()
        # resume_on_start 세션은 서버가 요청을 받기 시작한 뒤에 띄움 (카디널 MCP 에 붙어야 해서)
        resume_task = asyncio.create_task(sdk_mgr.resume_when_serving())
        # 살아있는 tmux 세션의 claude 는 서버가 꺼질 때 끊긴 카디널 MCP 를 스스로 안 붙음 → 하나씩 /mcp reconnect
        reconnect_task = asyncio.create_task(reconnect_tmux_mcp())
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
            resume_task.cancel()
            reconnect_task.cancel()
            await sdk_mgr.shutdown()
            await mcp_ctx.__aexit__(None, None, None)
            if discord:
                await discord.stop()

    app = FastAPI(title="Cardinal", lifespan=lifespan)
    # 인증은 MCP 쪽 헤더(세션 키)로 따로 함. 웹 UI 전체 받기(/{path}) 보다 먼저 붙여야 GET 이 안 뺏김
    app.mount("/mcp", cmcp.app)
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

    def pub(row: dict | None) -> dict | None:
        """API 로 내보내는 세션 행: sdk 옵션의 env/헤더 값은 가림"""
        if row and row.get("sdk_options") is not None:
            row = {**row, "sdk_options": redact_options(row["sdk_options"])}
        return row

    def sess_err(e: Exception) -> HTTPException:
        msg = str(e)
        return HTTPException(404 if msg.startswith("모르는") else 400, msg)

    def sdk_or_400(name: str):
        session_or_404(name)
        try:
            return sessions.sdk_session(name)
        except SessionError as e:
            raise sess_err(e)

    def tmux_only(name: str) -> None:
        if session_or_404(name)["backend"] == "sdk":
            raise HTTPException(400, f"SDK 세션엔 tmux 화면/키가 없음: {name} (/ws/sdk/{name} 사용)")

    api = [Depends(auth)]

    # ---------- 페이지 ----------

    # 웹 UI. 정적 파일엔 비밀이 없어서 토큰 없이 내려줌 (API/웹소켓은 토큰 필요)
    @app.get("/", include_in_schema=False)
    async def index():
        page = WEB_DIST / "index.html"
        return FileResponse(page) if page.is_file() else HTMLResponse(NOT_BUILT)

    @app.get("/api/health", dependencies=api)
    async def health():
        d = app.state.discord
        return {
            "ok": True,
            "channels": {"local": "ready", "discord": d.status if d else "off"},
            "sessions": len(db.sessions()),
            "sdk": {"enabled": settings.sdk, "default_backend": "sdk" if settings.sdk else "tmux",
                    "alive": sum(1 for x in sdk_mgr.sessions.values() if x.alive)},
        }

    # ---------- 세션 ----------

    @app.get("/api/sessions", dependencies=api)
    async def list_sessions(all: bool = False):
        return [pub(s) for s in db.sessions(include_deleted=all)]

    @app.post("/api/sessions", status_code=201, dependencies=api)
    async def create_session(body: SessionIn):
        # 상대 경로는 서버 프로세스 위치 기준이 돼서 헷갈리니 절대 경로만
        if body.cwd and not os.path.isabs(body.cwd):
            raise HTTPException(400, f"cwd 는 절대 경로여야 함: {body.cwd}")
        backend = body.backend or ("sdk" if settings.sdk else "tmux")
        if body.sdk and backend != "sdk":
            raise HTTPException(400, "sdk 옵션은 backend=sdk 에서만")
        sdk_opts = check_sdk_options(body.sdk or SdkOptionsIn()) if backend == "sdk" else None
        try:
            row = await sessions.create(name=body.name, role=body.role, prompt=body.prompt, cwd=body.cwd,
                                        backend=backend, sdk=sdk_opts, trust=body.trust, args=body.args)
        except SessionError as e:
            raise sess_err(e)
        routes = [db.add_route(row["id"], r.model_dump()) for r in body.routes]
        return {**(pub(row) or {}), "routes": routes}

    @app.get("/api/sessions/{name}", dependencies=api)
    async def get_session(name: str):
        s = session_or_404(name)
        out = {**(pub(s) or {}), "routes": db.routes(s["id"])}
        if s["backend"] == "sdk" and name in sdk_mgr.sessions:
            sess = sdk_mgr.sessions[name]
            out["pending"] = [p.public() for p in sess.pending.values()]
        return out

    @app.delete("/api/sessions/{name}", dependencies=api)
    async def delete_session(name: str, purge: bool = False):
        try:
            await sessions.kill(name, purge)
        except SessionError as e:
            raise sess_err(e)
        return {"ok": True}

    @app.post("/api/sessions/{name}/send", dependencies=api)
    async def send(name: str, body: SendIn):
        try:
            timeout_s = body.timeout_s or (DEFAULT_WAIT_TIMEOUT_S if body.wait else None)
            return await sessions.send(name, body.text, wait=body.wait, timeout_s=timeout_s,
                                       submit=body.submit, force=body.force, now=body.now,
                                       attachments=body.attachments)
        except SessionError as e:
            raise sess_err(e)

    @app.post("/api/sessions/{name}/keys", dependencies=api)
    async def keys(name: str, body: KeysIn):
        tmux_only(name)
        try:
            await cli.run("keys", name, *body.keys)
        except CliError as e:
            raise cli_call(e)
        return {"ok": True}

    @app.get("/api/sessions/{name}/screen", dependencies=api)
    async def screen(name: str, lines: int = 0):
        tmux_only(name)
        try:
            return {"screen": await cli.run("screen", name, "--lines", str(lines))}
        except CliError as e:
            raise cli_call(e)

    @app.get("/api/sessions/{name}/report", dependencies=api)
    async def report(name: str):
        try:
            return await sessions.report(name)
        except SessionError as e:
            raise sess_err(e)

    @app.get("/api/sessions/{name}/events", dependencies=api)
    async def session_events(name: str, limit: int = 200):
        return db.session_events(session_or_404(name)["id"], limit)

    # ---------- SDK 세션 제어 ----------

    @app.post("/api/sessions/{name}/interrupt", dependencies=api)
    async def sdk_interrupt(name: str):
        """작업 중인 턴 중단 (tmux 의 Esc). 기다리던 질문은 거부로 풀림"""
        try:
            await sdk_or_400(name).interrupt()
        except SdkError as e:
            raise HTTPException(400, str(e))
        return {"ok": True}

    @app.post("/api/sessions/{name}/restart", dependencies=api)
    async def sdk_restart(name: str, body: RestartIn | None = None):
        """끝난/살아있는 SDK 세션 다시 띄우기. 기본은 마지막 대화를 이어서 (resume)"""
        body = body or RestartIn()
        sess = sdk_or_400(name)
        if not settings.sdk:
            raise HTTPException(400, "SDK 모드가 꺼져 있음 (cardinal-server --sdk)")
        patch = None
        if body.sdk:
            patch = check_sdk_options(SdkOptionsIn(**{**sess.options, **unredact(body.sdk, sess.options)}))
        try:
            await sdk_mgr.restart(name, resume=body.resume, options=patch)
        except SdkError as e:
            raise HTTPException(400, str(e))
        return pub(db.session_by_id(sess.id))

    @app.get("/api/sessions/{name}/pending", dependencies=api)
    async def sdk_pending(name: str):
        return [p.public() for p in sdk_or_400(name).pending.values()]

    @app.post("/api/sessions/{name}/pending/{pid}", dependencies=api)
    async def sdk_answer(name: str, pid: str, body: AnswerIn):
        try:
            return sdk_or_400(name).answer(pid, body.answers, body.allow, body.message, body.updated_input)
        except LookupError as e:
            raise HTTPException(404, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))

    def live_client(name: str):
        sess = sdk_or_400(name)
        if not sess.alive or not sess.client:
            raise HTTPException(400, f"세션 안 살아있음: {name}")
        return sess

    @app.get("/api/sessions/{name}/mcp", dependencies=api)
    async def sdk_mcp(name: str):
        return await live_client(name).client.get_mcp_status()

    @app.post("/api/sessions/{name}/mcp/{server}", dependencies=api)
    async def sdk_mcp_action(name: str, server: str, body: McpActionIn):
        c = live_client(name).client
        try:
            if body.action == "reconnect":
                await c.reconnect_mcp_server(server)
            else:
                await c.toggle_mcp_server(server, body.action == "enable")
        except Exception as e:
            raise HTTPException(400, f"MCP {server} {body.action} 실패: {e}")
        return await c.get_mcp_status()

    @app.post("/api/sessions/{name}/model", dependencies=api)
    async def sdk_model(name: str, body: ModelIn):
        sess = live_client(name)
        await sess.client.set_model(body.model)
        sess.options = {**sess.options, "model": body.model}
        db.update_sdk_session(sess.id, sdk_options=sess.options)
        return {"ok": True, "model": body.model}

    @app.post("/api/sessions/{name}/permission-mode", dependencies=api)
    async def sdk_mode(name: str, body: ModeIn):
        sess = live_client(name)
        await sess.client.set_permission_mode(body.mode)
        sess.options = {**sess.options, "permission_mode": body.mode}
        db.update_sdk_session(sess.id, sdk_options=sess.options)
        return {"ok": True, "mode": body.mode}

    @app.get("/api/sessions/{name}/context", dependencies=api)
    async def sdk_context(name: str):
        return await live_client(name).client.get_context_usage()

    @app.get("/api/sessions/{name}/turns", dependencies=api)
    async def sdk_turns(name: str, limit: int = 20):
        return db.sdk_turns(sdk_or_400(name).id, limit)

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

    # ---------- 웹드라이브 ----------

    def drive_call(fn, *a, **kw):
        try:
            return fn(*a, **kw)
        except DriveError as e:
            raise HTTPException(404 if str(e).startswith(("없음", "파일이 없음")) else 400, str(e))
        except OSError as e:
            raise HTTPException(400, f"파일 작업 실패: {e}")

    async def save_uploads(dir_path: str, files: list[UploadFile], overwrite: bool) -> list[dict]:
        out = []
        for f in files:
            try:
                out.append(await drive.save_upload(dir_path, f.filename or "file", f.read, overwrite))
            except DriveError as e:
                raise HTTPException(413 if "너무 큼" in str(e) else 400, str(e))
            except OSError as e:
                raise HTTPException(400, f"저장 실패: {e}")
        return out

    @app.get("/api/drive", dependencies=api)
    async def drive_list(path: str = "/"):
        """폴더 내용 (entries: name, path, type, size, mtime, content_type, local_path)"""
        return drive_call(drive.list, path)

    @app.get("/api/drive/file", dependencies=api)
    async def drive_file(path: str, download: bool = False):
        """파일 받기. download=false 면 브라우저에서 바로 보기 (이미지, PDF 등)"""
        f = drive_call(drive.file, path)
        return FileResponse(f, filename=f.name, content_disposition_type="attachment" if download else "inline")

    @app.get("/api/drive/text", dependencies=api)
    async def drive_read_text(path: str):
        """UTF-8 글 파일 내용 (웹 편집기용, 2MB 까지)"""
        return drive_call(drive.read_text, path)

    @app.put("/api/drive/text", dependencies=api)
    async def drive_write_text(body: DriveTextIn):
        """글 파일 만들기/고치기 (폴더는 알아서 만듦)"""
        return drive_call(drive.write_text, body.path, body.content, "/", body.overwrite)

    @app.post("/api/drive/upload", status_code=201, dependencies=api)
    async def drive_upload(path: str = Form("/shared"), overwrite: bool = Form(False),
                           files: list[UploadFile] = File(...)):
        """path 폴더에 파일 올리기 (없으면 만듦). 같은 이름은 overwrite 가 아니면 'a (1).txt' 로"""
        drive_call(drive.local, path)
        return await save_uploads(path, files, overwrite)

    @app.post("/api/drive/mkdir", status_code=201, dependencies=api)
    async def drive_mkdir(body: DrivePathIn):
        return drive_call(drive.mkdir, body.path)

    @app.post("/api/drive/move", dependencies=api)
    async def drive_move(body: DriveMoveIn):
        return drive_call(drive.move, body.src, body.dst, body.overwrite)

    @app.delete("/api/drive", dependencies=api)
    async def drive_delete(path: str, recursive: bool = False):
        drive_call(drive.delete, path, recursive)
        return {"ok": True}

    @app.post("/api/sessions/{name}/attachments", status_code=201, dependencies=api)
    async def session_attachments(name: str, files: list[UploadFile] = File(...)):
        """요청에 붙일 파일을 세션 드라이브 폴더(attachments/)에 저장. 돌려받은 path 를 send 의 attachments 로"""
        session_or_404(name)
        drive.ensure_session(name)
        return await save_uploads(f"{drive.session_path(name)}/{ATTACHMENTS}", files, False)

    # ---------- 웹소켓 ----------

    @app.websocket("/ws/term/{name}")
    async def ws_term(ws: WebSocket, name: str, cols: int = 120, rows: int = 40, readonly: int = 0):
        if not await ws_auth(ws):
            return
        s = db.session_by_name(name)
        if not s or not s["alive"]:
            await ws.close(code=4404, reason="unknown or dead session")
            return
        if s["backend"] == "sdk":
            await ws.close(code=4400, reason="sdk session has no terminal (use /ws/sdk)")
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

    @app.websocket("/ws/sdk/{name}")
    async def ws_sdk(ws: WebSocket, name: str):
        """SDK 세션 실시간 연결 (프로그램용: 음성/모션 등).
        받음: {"type":"hello"}, {"type":"state"}, {"type":"message","message":<SDK 메시지>}, {"type":"turn"},
              {"type":"pending"}, {"type":"pending_done"}, {"type":"result","id":..,"ok":..,"data"|"error":..}
        보냄: {"type":"send","text":..,"attachments":[<드라이브 경로>],"wait":bool,"now":bool,"force":bool,"timeout_s":..,
               "id":<내 요청 ID>},
              {"type":"interrupt","id":..}, {"type":"answer","pending_id":..,"answers":{..}|"allow":bool,"id":..}"""
        if not await ws_auth(ws):
            return
        row = db.session_by_name(name)
        sess = sdk_mgr.sessions.get(name) if row and row["backend"] == "sdk" else None
        if not sess:
            await ws.close(code=4404, reason="unknown sdk session")
            return
        await ws.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        sess.subscribers.add(q)
        tasks: set[asyncio.Task] = set()

        async def send_json(m: dict) -> None:
            await ws.send_text(json.dumps(m, default=str, ensure_ascii=False))

        async def pump() -> None:
            while True:
                await send_json(await q.get())

        async def run(cmd: dict) -> None:
            rid = cmd.get("id")
            try:
                kind = cmd.get("type")
                if kind == "send":
                    data = await sessions.send(name, str(cmd.get("text") or ""), wait=bool(cmd.get("wait")),
                                               timeout_s=cmd.get("timeout_s"), now=bool(cmd.get("now")),
                                               force=bool(cmd.get("force")),
                                               attachments=[str(a) for a in cmd.get("attachments") or []])
                elif kind == "interrupt":
                    await sess.interrupt()
                    data = {"ok": True}
                elif kind == "answer":
                    data = sess.answer(cmd["pending_id"], cmd.get("answers"), cmd.get("allow", True),
                                       cmd.get("message"), cmd.get("updated_input"))
                else:
                    raise ValueError(f"모르는 type: {kind}")
                await q.put({"type": "result", "id": rid, "ok": True, "data": data})
            except Exception as e:
                await q.put({"type": "result", "id": rid, "ok": False, "error": str(e)})

        pumper = asyncio.create_task(pump())
        try:
            await send_json({"type": "hello", "session": pub(db.session_by_id(sess.id)), "status": sess.status(),
                             "pending": [p.public() for p in sess.pending.values()], "report": sess.report()})
            while True:
                raw = await ws.receive_text()
                try:
                    cmd = json.loads(raw)
                except ValueError:
                    await q.put({"type": "result", "ok": False, "error": "JSON 아님"})
                    continue
                if cmd.get("type") == "send" and not str(cmd.get("text") or "").strip() and not cmd.get("attachments"):
                    await q.put({"type": "result", "id": cmd.get("id"), "ok": False, "error": "text 필요"})
                    continue
                t = asyncio.create_task(run(cmd))
                tasks.add(t)
                t.add_done_callback(tasks.discard)
        except WebSocketDisconnect:
            pass
        finally:
            sess.subscribers.discard(q)
            pumper.cancel()
            # 진행 중인 요청은 끊지 않음: send 를 중간에 취소하면 세션 쪽 순서가 꼬일 수 있음.
            # 끝나면 결과만 아무도 안 읽는 큐에 들어가고 버려짐

    @app.websocket("/ws/events")
    async def ws_events(ws: WebSocket):
        if await ws_auth(ws):
            await subscribe(ws, events_hub, {"type": "sessions", "sessions": [pub(x) for x in db.sessions()]})

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

    # 웹 UI 정적 파일 (assets/*, banner.png 등). 맨 마지막에 등록해서 API 라우트를 가로채지 않음.
    # 빌드를 나중에 해도 서버 재시작 없이 바로 보이게 요청 때마다 파일을 찾음
    @app.get("/{path:path}", include_in_schema=False)
    async def web_static(path: str):
        if path.startswith(("api/", "ws/")):
            raise HTTPException(404, "not found")
        f = (WEB_DIST / path).resolve()
        # dist 밖으로 나가는 경로(../) 차단
        if WEB_DIST in f.parents and f.is_file():
            return FileResponse(f)
        raise HTTPException(404, "not found")

    return app
