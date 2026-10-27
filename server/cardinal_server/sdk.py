"""SDK 모드 세션: Claude Agent SDK(ClaudeSDKClient)를 서버 프로세스 안에서 직접 돌림. tmux / TUI 없음.

- 세션 하나 = ClaudeSDKClient 하나 + 메시지 읽는 태스크 하나. 서버가 꺼지면 세션도 끝남 (restart 로 대화 이어가기)
- 상태는 tmux 세션과 같은 값: starting / idle / busy / waiting / ended
- send 는 tmux 쪽과 같은 규칙: 세션별로 한 줄로 세우고, 작업 중이면 idle 될 때까지 기다림
  (작업 중에 넣으면 SDK 도 진행 중인 턴에 끼워 넣어서 응답이 하나로 합쳐짐. 실측)
- 질문(AskUserQuestion)·권한 확인은 can_use_tool 로 받아서 "pending" 으로 들고 있다가 API 로 답을 받음 (그동안 waiting)
- 카디널 도구(reply, 세션 제어)는 프로세스 안 MCP 서버(mcp__cardinal__*)로 줌. Bash 로 cardinal CLI 를 부를 필요 없음
"""

import asyncio
import dataclasses
import json
import logging
import os
import secrets
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    HookMatcher,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ToolUseBlock,
    UserMessage,
    create_sdk_mcp_server,
    tool,
)

from .channel.base import OutboundFile
from .config import REPO_ROOT, Settings
from .db import DB, now

log = logging.getLogger("cardinal.sdk")

# 받았다는 신호(턴 시작)를 이만큼 기다림
ACCEPT_TIMEOUT_S = 15
# 턴 시작을 알리는 것: 매 query 마다 오는 init 시스템 메시지, UserPromptSubmit 훅
QUEUE_TIMEOUT_S = 600
MAX_REPLY_FILES = 10
MAX_REPLY_FILE_BYTES = 10 * 1024 * 1024
TOOL_INPUT_CLIP = 300
HOOK_EVENTS = ("PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop",
               "SubagentStart", "SubagentStop", "PreCompact", "Notification", "PermissionRequest")
INTERRUPT_MARK = "[Request interrupted by user"

COMMON_PROMPT = """
너는 카디널(Cardinal) 서버가 Claude Agent SDK 로 띄운 세션 "{name}" 이고 레벨은 {role} 이다 (tmux/터미널 없음).

`[cardinal:event <이벤트ID>]` 로 시작하는 메시지는 외부 채널(디스코드 등)에서 온 이벤트다.
그 이벤트에 답할 때는 응답 텍스트만으로는 전달되지 않는다. 반드시 `mcp__cardinal__reply` 도구로 보내라
(event_id, text, files: 첨부할 로컬 파일 경로 목록, 최대 10개·각 10MB). 이벤트 첨부파일은 메시지에 적힌 로컬 경로에 있다.
사용자에게 확인이 필요하면 AskUserQuestion 을 써도 된다 (카디널이 사람에게 전달하고 답을 돌려줌).
"""

MASTER_PROMPT = """
너는 마스터 세션이다. 작업을 나눌 때는 내장 서브 에이전트(Agent 도구) 대신 카디널 도구로 독립 워커 세션을 띄워서 맡겨라.
- 워커 만들기: `mcp__cardinal__session_new` (name, prompt, wait). 워커는 기본으로 너와 같은 작업 폴더에서 뜬다
- 지시 추가: `mcp__cardinal__session_send` (name, text, wait=true 면 응답까지 받음)
- 상태/결과: `mcp__cardinal__session_list`, `mcp__cardinal__session_report` (작업중/완료 + 마지막 턴 응답 전체)
- 정리: `mcp__cardinal__session_kill`
사용자가 서브 에이전트를 쓰라고 따로 요청한 경우에만 예외.
"""


class SdkError(Exception):
    pass


def _clip(s: str | None, n: int) -> str | None:
    if s is None:
        return None
    return s if len(s) <= n else s[:n] + "…"


def to_json(m: Any) -> Any:
    """SDK 메시지(데이터클래스) → JSON 으로 보낼 dict. 타입 이름은 type 에"""
    if dataclasses.is_dataclass(m) and not isinstance(m, type):
        d = {f.name: to_json(getattr(m, f.name)) for f in dataclasses.fields(m)}
        return {"type": type(m).__name__, **d}
    if isinstance(m, dict):
        return {k: to_json(v) for k, v in m.items()}
    if isinstance(m, (list, tuple)):
        return [to_json(v) for v in m]
    if isinstance(m, (str, int, float, bool)) or m is None:
        return m
    return str(m)


def redact_options(opts: dict | None) -> dict:
    """세션 목록에 내보낼 때 env / MCP 헤더 값은 가림 (토큰이 들어갈 수 있음)"""
    o = json.loads(json.dumps(opts or {}))
    if isinstance(o.get("env"), dict):
        o["env"] = {k: "***" for k in o["env"]}
    for srv in (o.get("mcp_servers") or {}).values():
        if isinstance(srv, dict):
            for key in ("env", "headers"):
                if isinstance(srv.get(key), dict):
                    srv[key] = {k: "***" for k in srv[key]}
    return o


@dataclasses.dataclass
class Turn:
    origin: str  # human | agent
    prompt: str
    prompt_at: str
    db_id: int = 0
    texts: list[str] = dataclasses.field(default_factory=list)
    tools: list[dict] = dataclasses.field(default_factory=list)
    complete: bool = False
    interrupted: bool = False
    result: dict | None = None
    ended_at: str | None = None
    started: asyncio.Event = dataclasses.field(default_factory=asyncio.Event)
    done: asyncio.Event = dataclasses.field(default_factory=asyncio.Event)

    def public(self) -> dict:
        # CLI report 의 turn 과 같은 모양 (웹 UI 가 그대로 씀)
        return {"prompt": self.prompt, "promptAt": self.prompt_at, "texts": self.texts, "tools": self.tools,
                "complete": self.complete, "interrupted": self.interrupted, "endedAt": self.ended_at,
                "origin": self.origin, "result": self.result}

    def record(self) -> dict:
        return {"origin": self.origin, "prompt": self.prompt, "prompt_at": self.prompt_at, "texts": self.texts,
                "tools": self.tools, "complete": self.complete, "interrupted": self.interrupted,
                "result": self.result, "ended_at": self.ended_at}


@dataclasses.dataclass
class Pending:
    """사람 답을 기다리는 것: 질문(AskUserQuestion) 또는 권한 확인"""

    id: str
    kind: str  # question | permission
    tool: str
    input: dict
    created_at: str
    title: str | None = None
    description: str | None = None
    future: asyncio.Future = dataclasses.field(default_factory=lambda: asyncio.get_running_loop().create_future())

    def public(self) -> dict:
        return {"id": self.id, "kind": self.kind, "tool": self.tool, "input": self.input,
                "created_at": self.created_at, "title": self.title, "description": self.description}


class SdkSession:
    def __init__(self, mgr: "SdkManager", row: dict):
        self.mgr = mgr
        self.db: DB = mgr.db
        self.id: str = row["id"]
        self.name: str = row["name"]
        self.role: str = row["role"]
        self.cwd: str = row["cwd"]
        self.options: dict = row.get("sdk_options") or {}
        self.claude_session_id: str | None = row.get("claude_session_id")
        self.client: ClaudeSDKClient | None = None
        self.alive = False
        self.state = "starting"
        self.event: str | None = "Create"
        self.detail: str | None = None
        self.tool: str | None = None
        self.transcript_path: str | None = row.get("transcript_path")
        self.open_turns: list[Turn] = []  # 아직 결과가 안 온 턴 (보낸 순서)
        self.last_turn: Turn | None = None
        self.pending: dict[str, Pending] = {}
        self.subscribers: set[asyncio.Queue] = set()
        self.send_lock = asyncio.Lock()
        self.idle = asyncio.Event()
        self._reader: asyncio.Task | None = None
        self._stopping = False

    # ---------- 상태 ----------

    def _set(self, state: str | None = None, event: str | None = None, detail: str | None = None,
             tool: str | None | bool = False, persist: bool = True) -> None:
        if state:
            self.state = state
        if event:
            self.event = event
        self.detail = detail
        if tool is not False:
            self.tool = tool  # type: ignore[assignment]
        if self.state == "idle":
            self.idle.set()
        else:
            self.idle.clear()
        if persist:
            self.db.update_sdk_session(self.id, alive=self.alive, state=self.state, state_at=now(),
                                       last_event=self.event, detail=self.detail, tool=self.tool,
                                       transcript_path=self.transcript_path, claude_session_id=self.claude_session_id)
            self.mgr.changed()
            self._emit({"type": "state", "state": self.state, "event": self.event, "detail": self.detail,
                        "tool": self.tool, "alive": self.alive})

    def status(self) -> dict:
        return {"state": self.state, "event": self.event, "detail": self.detail, "tool": self.tool,
                "alive": self.alive, "pending": len(self.pending)}

    def _emit(self, msg: dict) -> None:
        """/ws/sdk/<이름> 구독자에게. 느린 구독자는 넘치면 버림 (세션 흐름을 안 막게)"""
        for q in list(self.subscribers):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                self.subscribers.discard(q)

    def _record_event(self, e: dict) -> None:
        self.db.add_session_event(self.id, {"at": now(), **{k: v for k, v in e.items() if v is not None}})

    # ---------- 시작 / 종료 ----------

    def _build_options(self, resume: str | None, fresh_id: str | None) -> ClaudeAgentOptions:
        o = self.options
        prompt = COMMON_PROMPT.format(name=self.name, role=self.role) + (MASTER_PROMPT if self.role == "master" else "")
        if o.get("append_prompt"):
            prompt += "\n" + o["append_prompt"]
        mcp: dict[str, Any] = dict(o.get("mcp_servers") or {})
        mcp["cardinal"] = cardinal_tools(self)
        allowed = list(o.get("allowed_tools") or [])
        # 카디널 도구는 서버가 직접 처리하는 거라 묻지 않음
        allowed.append("mcp__cardinal")
        env = {
            **{k: str(v) for k, v in (o.get("env") or {}).items()},
            "CARDINAL_SESSION": self.name,
            "CARDINAL_INSTANCE": self.id,
            "CARDINAL_ROLE": self.role,
            "CARDINAL_HOME": str(self.mgr.settings.home),
            "CARDINAL_SERVER_URL": self.mgr.settings.url,
            # Bash 도구에서 cardinal CLI 도 쓸 수 있게 (reply 는 mcp__cardinal__reply 가 기본)
            "PATH": f"{REPO_ROOT / 'bin'}:{os.environ.get('PATH', '')}",
            "CLAUDE_AGENT_SDK_CLIENT_APP": "cardinal",
        }
        kw: dict[str, Any] = dict(
            cwd=self.cwd,
            permission_mode=o.get("permission_mode") or "auto",
            system_prompt={"type": "preset", "preset": "claude_code", "append": prompt},
            mcp_servers=mcp,
            allowed_tools=allowed,
            disallowed_tools=list(o.get("disallowed_tools") or []),
            can_use_tool=self._can_use_tool,
            hooks={ev: [HookMatcher(hooks=[self._hook])] for ev in HOOK_EVENTS},
            include_partial_messages=bool(o.get("partial")),
            add_dirs=list(o.get("add_dirs") or []),
            env=env,
            stderr=lambda line: log.debug("[%s] %s", self.name, line.rstrip()),
        )
        for key in ("model", "fallback_model", "effort", "max_turns", "max_budget_usd", "setting_sources",
                    "strict_mcp_config"):
            if o.get(key) is not None:
                kw[key] = o[key]
        if resume:
            kw["resume"] = resume
        elif fresh_id:
            kw["session_id"] = fresh_id
        return ClaudeAgentOptions(**kw)

    async def start(self, resume: bool) -> None:
        """resume=True 면 마지막 claude 세션을 이어서, 아니면 새 대화"""
        self._stopping = False
        fresh = None if resume and self.claude_session_id else str(uuid.uuid4())
        if fresh:
            self.claude_session_id = fresh
        self._set("starting", "Create" if fresh else "Resume", None, None)
        client = ClaudeSDKClient(self._build_options(None if fresh else self.claude_session_id, fresh))
        try:
            await client.connect()
        except Exception as e:
            self.alive = False
            self._set("ended", "StartFailed", f"시작 실패: {e}")
            raise SdkError(f"SDK 세션 시작 실패: {e}") from e
        self.client = client
        self.alive = True
        self._reader = asyncio.create_task(self._read_loop())
        self._set("idle", "SessionStart", None, None)
        self._record_event({"event": "SessionStart", "source": "resume" if not fresh else "startup"})

    async def stop(self, reason: str = "종료") -> None:
        self._stopping = True
        client, self.client = self.client, None
        if self._reader:
            self._reader.cancel()
            self._reader = None
        if client:
            try:
                await asyncio.wait_for(client.disconnect(), 10)
            except Exception as e:
                log.warning("[%s] disconnect 실패: %s", self.name, e)
        self._ended(reason)

    def _ended(self, reason: str) -> None:
        self.alive = False
        for p in list(self.pending.values()):
            if not p.future.done():
                p.future.set_result(PermissionResultDeny(message="세션 종료", interrupt=True))
        self.pending.clear()
        for t in self.open_turns:
            t.interrupted = True
            t.ended_at = now()
            self._save_turn(t)
            t.started.set()
            t.done.set()
        self.open_turns.clear()
        self._set("ended", "SessionEnd", reason, None)
        self._record_event({"event": "SessionEnd", "reason": reason})

    # ---------- 메시지 읽기 ----------

    async def _read_loop(self) -> None:
        try:
            assert self.client
            async for m in self.client.receive_messages():
                try:
                    self._on_message(m)
                except Exception:
                    log.exception("[%s] 메시지 처리 실패", self.name)
            if not self._stopping:
                self._ended("claude 프로세스가 끝남")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("[%s] 읽기 끝남: %s", self.name, e)
            if not self._stopping:
                self._ended(f"claude 프로세스 오류: {e}")

    def _current(self) -> Turn | None:
        return self.open_turns[-1] if self.open_turns else None

    def _start_agent_turn(self) -> Turn:
        """우리가 안 보낸 턴 (백그라운드 작업 알림 등)"""
        t = Turn(origin="agent", prompt="(백그라운드 알림)", prompt_at=now())
        t.db_id = self.db.add_sdk_turn(self.id, t.record())
        self.open_turns.append(t)
        return t

    def _save_turn(self, t: Turn) -> None:
        if t.db_id:
            self.db.update_sdk_turn(t.db_id, t.record())

    def _on_message(self, m: Any) -> None:
        if not isinstance(m, StreamEvent):
            sid = getattr(m, "session_id", None)
            if sid and sid != self.claude_session_id:
                self.claude_session_id = sid  # /clear 등으로 바뀜
        self._emit({"type": "message", "message": to_json(m)})
        if isinstance(m, StreamEvent):
            return

        if isinstance(m, SystemMessage) and m.subtype == "init":
            # 매 턴 시작마다 옴. 우리가 보낸 게 아직 시작 안 했으면 그것, 아니면 우리가 안 보낸 턴
            waiting = next((t for t in self.open_turns if not t.started.is_set()), None)
            if waiting:
                waiting.started.set()
            elif not self.open_turns:
                self._start_agent_turn().started.set()
            if self.state != "waiting":
                self._set("busy", "TurnStart", None)
            return

        if isinstance(m, AssistantMessage) and not m.parent_tool_use_id:
            t = self._current() or self._start_agent_turn()
            for b in m.content:
                if isinstance(b, TextBlock) and b.text:
                    t.texts.append(b.text)
                elif isinstance(b, ToolUseBlock):
                    t.tools.append({"name": b.name, "input": _clip(json.dumps(b.input, ensure_ascii=False), TOOL_INPUT_CLIP)})
            self._save_turn(t)
            return

        if isinstance(m, UserMessage) and not m.parent_tool_use_id:
            texts = [m.content] if isinstance(m.content, str) else [getattr(b, "text", "") for b in m.content]
            if any(x.startswith(INTERRUPT_MARK) for x in texts if x):
                if t := self._current():
                    t.interrupted = True
            return

        if isinstance(m, ResultMessage):
            self._on_result(m)

    def _on_result(self, m: ResultMessage) -> None:
        origin = (m.origin or {}).get("kind") if isinstance(m.origin, dict) else getattr(m.origin, "kind", None)
        if origin == "task-notification":
            t = next((x for x in self.open_turns if x.origin == "agent"), None) or self._start_agent_turn()
        else:
            # 사람 쪽(우리가 보낸) 턴은 보낸 순서대로 끝남
            t = next((x for x in self.open_turns if x.origin == "human"), None) or self._current()
        aborted = (m.terminal_reason or "").startswith("aborted")
        summary = {"subtype": m.subtype, "is_error": m.is_error, "terminal_reason": m.terminal_reason,
                   "stop_reason": m.stop_reason, "num_turns": m.num_turns, "duration_ms": m.duration_ms,
                   "total_cost_usd": m.total_cost_usd, "result": _clip(m.result, 2000),
                   "errors": m.errors, "api_error_status": m.api_error_status}
        if t:
            t.interrupted = t.interrupted or aborted
            t.complete = not t.interrupted and m.subtype == "success" and not m.is_error
            t.result = summary
            t.ended_at = now()
            # 응답 텍스트 블록이 없었는데 result 가 있으면 그걸로 (예: 오류 문구)
            if not t.texts and m.result:
                t.texts.append(m.result)
            self._save_turn(t)
            self.open_turns.remove(t)
            if t.origin == "human":
                self.last_turn = t
            t.started.set()
            t.done.set()
            self._emit({"type": "turn", "turn": t.public()})
        # 훅의 Stop 과 겹치지 않게 결과는 Result 로 남김 (중단이면 Interrupted)
        self._record_event({"event": "Interrupted" if aborted else "Result", "reason": m.terminal_reason,
                            "message": m.subtype if m.is_error else None})
        if not self.open_turns and not self.pending:
            if aborted:
                self._set("idle", "Interrupted", "사람이 중단함", None)
            elif m.is_error:
                self._set("idle", "Stop", f"오류로 끝남: {m.terminal_reason or m.subtype}", None)
            else:
                self._set("idle", "Stop", None, None)

    # ---------- 훅 / 권한 ----------

    async def _hook(self, data: dict, tool_use_id: str | None, ctx: Any) -> dict:
        ev = data.get("hook_event_name", "?")
        if data.get("transcript_path"):
            self.transcript_path = data["transcript_path"]
        tool_input = data.get("tool_input")
        self._record_event({
            "event": ev,
            "tool": data.get("tool_name"),
            "prompt": _clip(data.get("prompt"), 2000),
            "message": data.get("message"),
            "notificationType": data.get("notification_type"),
            "toolInput": _clip(json.dumps(tool_input, ensure_ascii=False), TOOL_INPUT_CLIP) if tool_input is not None else None,
            "agentType": data.get("agent_type"),
        })
        if ev == "UserPromptSubmit":
            waiting = next((t for t in self.open_turns if not t.started.is_set()), None)
            if waiting:
                waiting.started.set()
        if self.state != "waiting":
            if ev == "PreToolUse":
                self._set("busy", ev, None, data.get("tool_name"))
            elif ev in ("PostToolUse", "PostToolUseFailure"):
                self._set("busy", ev, None, None)
        return {}

    async def _can_use_tool(self, tool_name: str, tool_input: dict, ctx: Any) -> Any:
        """auto 모드에서도 질문(AskUserQuestion)은 여기로 옴 (실측). 사람 답이 올 때까지 waiting"""
        p = Pending(
            id="q_" + secrets.token_hex(4),
            kind="question" if tool_name == "AskUserQuestion" else "permission",
            tool=tool_name,
            input=tool_input,
            created_at=now(),
            title=getattr(ctx, "title", None),
            description=getattr(ctx, "description", None),
        )
        self.pending[p.id] = p
        self._record_event({"event": "Question" if p.kind == "question" else "PermissionAsk", "tool": tool_name,
                            "toolInput": _clip(json.dumps(tool_input, ensure_ascii=False), TOOL_INPUT_CLIP)})
        detail = "질문에 답 필요" if p.kind == "question" else f"권한 확인 필요: {tool_name}"
        self._set("waiting", "Pending", detail, tool_name)
        self._emit({"type": "pending", "pending": p.public()})
        timeout = self.options.get("question_timeout_s")
        try:
            if timeout:
                return await asyncio.wait_for(asyncio.shield(p.future), timeout)
            return await p.future
        except asyncio.TimeoutError:
            return PermissionResultDeny(message=f"{timeout}초 안에 사람 답이 없음. 스스로 판단해서 진행해라")
        finally:
            self.pending.pop(p.id, None)
            self._emit({"type": "pending_done", "id": p.id})
            if self.alive and not self.pending:
                self._set("busy", "Answered", None, None)

    def answer(self, pid: str, answers: dict[str, str] | None = None, allow: bool = True,
               message: str | None = None, updated_input: dict | None = None) -> dict:
        p = self.pending.get(pid)
        if not p or p.future.done():
            raise LookupError(f"기다리는 질문/권한이 없음: {pid}")
        if p.kind == "question":
            if not allow:
                res: Any = PermissionResultDeny(message=message or "사람이 답하지 않기로 함. 스스로 판단해서 진행해라")
            else:
                if not answers:
                    raise ValueError("answers 필요: {질문 텍스트: 고른 답}")
                res = PermissionResultAllow(updated_input={**p.input, "answers": answers})
        elif allow:
            res = PermissionResultAllow(updated_input=updated_input or p.input)
        else:
            res = PermissionResultDeny(message=message or "사람이 거부함")
        p.future.set_result(res)
        self._record_event({"event": "Answered", "tool": p.tool, "message": "allow" if allow else "deny"})
        return {"ok": True, "id": pid}

    # ---------- 보내기 / 제어 ----------

    async def _wait_idle(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while not (self.state == "idle" and not self.open_turns):
            if not self.alive:
                raise SdkError(f"세션 안 살아있음: {self.name}")
            left = deadline - time.monotonic()
            if left <= 0:
                raise SdkError(f"{int(timeout)}초 동안 idle 이 안 됨 ({self.state})")
            try:
                await asyncio.wait_for(self.idle.wait(), min(left, 1.0))
            except asyncio.TimeoutError:
                pass

    async def send(self, text: str, *, wait: bool = False, timeout_s: float | None = None, now_: bool = False,
                   force: bool = False, queue_timeout_s: float = QUEUE_TIMEOUT_S) -> dict:
        if not self.alive or not self.client:
            raise SdkError(f"세션 안 살아있음: {self.name}")
        try:
            await asyncio.wait_for(self.send_lock.acquire(), queue_timeout_s)
        except asyncio.TimeoutError:
            raise SdkError(f"{int(queue_timeout_s)}초 동안 차례가 안 옴")
        try:
            if self.state == "waiting" and not force:
                raise SdkError(f"{self.name}: 질문/권한 답을 기다리는 중 (pending). 답하거나 force")
            injected = None
            if now_:
                # 진행 중인 턴에 끼워 넣음 → 결과가 그 턴과 하나로 합쳐지니 같은 턴으로 봄
                injected = next((t for t in self.open_turns if t.origin == "human"), None)
            else:
                await self._wait_idle(queue_timeout_s)
            sent_at = time.time()
            if injected:
                injected.prompt += "\n\n" + text
                turn = injected
            else:
                turn = Turn(origin="human", prompt=text, prompt_at=now())
                turn.db_id = self.db.add_sdk_turn(self.id, turn.record())
                self.open_turns.append(turn)
                self._set("busy", "UserPromptSubmit", None, None)
            try:
                await self.client.query(text)
            except Exception as e:
                if turn in self.open_turns and not injected:
                    self.open_turns.remove(turn)
                raise SdkError(f"보내기 실패: {e}") from e
        finally:
            self.send_lock.release()

        try:
            await asyncio.wait_for(turn.started.wait(), ACCEPT_TIMEOUT_S)
            accepted = True
        except asyncio.TimeoutError:
            accepted = False
        if not wait:
            return {"sentAt": int(sent_at * 1000), "accepted": accepted}
        timed_out = False
        try:
            await asyncio.wait_for(turn.done.wait(), timeout_s)
        except asyncio.TimeoutError:
            timed_out = True
        last = "\n\n".join(turn.texts) if turn.texts else None
        return {"sentAt": int(sent_at * 1000), "accepted": accepted, "timedOut": timed_out,
                "interrupted": turn.interrupted and not timed_out, "status": self.status(), "last": last}

    async def interrupt(self) -> None:
        if not self.client:
            raise SdkError(f"세션 안 살아있음: {self.name}")
        # 답을 기다리던 질문은 거부로 풀어줘야 턴이 멈춤
        for p in list(self.pending.values()):
            if not p.future.done():
                p.future.set_result(PermissionResultDeny(message="사람이 중단함", interrupt=True))
        await self.client.interrupt()

    def report(self) -> dict:
        if self.last_turn is None:
            rows = self.db.sdk_turns(self.id, limit=1, origin="human")
            turn = _turn_from_row(rows[-1]) if rows else None
        else:
            turn = self.last_turn.public()
        current = next((t for t in self.open_turns if t.origin == "human"), None)
        if current:
            turn = current.public()
        return {"status": {**self.status(), "trustPrompt": False}, "phase": phase_of(self.alive, self.state, self.event),
                "transcript": self.transcript_path, "turn": turn, "pending": [p.public() for p in self.pending.values()]}


def _turn_from_row(r: dict) -> dict:
    return {"prompt": r["prompt"], "promptAt": r["prompt_at"], "texts": r["texts"], "tools": r["tools"],
            "complete": r["complete"], "interrupted": r["interrupted"], "endedAt": r["ended_at"],
            "origin": r["origin"], "result": r["result"]}


def phase_of(alive: bool, state: str, event: str | None) -> str:
    # CLI report 와 같은 규칙
    if not alive or state == "ended":
        return "dead"
    if state == "busy":
        return "working"
    if state == "idle":
        return "interrupted" if event == "Interrupted" else "done"
    return state


# ---------- 카디널 도구 (프로세스 안 MCP 서버) ----------


def _text(s: str, error: bool = False) -> dict:
    out: dict[str, Any] = {"content": [{"type": "text", "text": s}]}
    if error:
        out["is_error"] = True
    return out


def cardinal_tools(sess: SdkSession):
    mgr = sess.mgr

    @tool("reply", "외부 채널 이벤트([cardinal:event <ID>])에 답장. files 는 첨부할 로컬 파일 경로 목록 (최대 10개, 각 10MB)",
          {"type": "object", "properties": {
              "event_id": {"type": "string"}, "text": {"type": "string"},
              "files": {"type": "array", "items": {"type": "string"}}},
           "required": ["event_id", "text"]})
    async def reply(args: dict) -> dict:
        files = args.get("files") or []
        if len(files) > MAX_REPLY_FILES:
            return _text(f"첨부는 최대 {MAX_REPLY_FILES}개", True)
        out = []
        for f in files:
            p = Path(f) if os.path.isabs(f) else Path(sess.cwd) / f
            try:
                if p.stat().st_size > MAX_REPLY_FILE_BYTES:
                    return _text(f"파일이 너무 큼 (> 10MB): {p}", True)
                out.append(OutboundFile(p.name, p.read_bytes(), None))
            except OSError as e:
                return _text(f"파일을 못 읽음: {p} ({e})", True)
        if not (args.get("text") or "").strip() and not out:
            return _text("보낼 텍스트나 파일이 필요", True)
        try:
            saved = await mgr.router.reply(args["event_id"], sess.name, args.get("text", ""), out)
        except Exception as e:
            return _text(f"답장 실패: {e}", True)
        return _text(f"답장 보냄 (reply {saved['id']})")

    @tool("session_list", "카디널 세션 목록과 상태", {"type": "object", "properties": {}})
    async def session_list(args: dict) -> dict:
        rows = [{k: s[k] for k in ("name", "role", "backend", "state", "alive", "cwd", "parent_name")}
                for s in mgr.db.sessions()]
        return _text(json.dumps(rows, ensure_ascii=False, indent=1))

    @tool("session_new", "워커 세션 만들기. cwd 를 안 주면 이 세션의 작업 폴더. wait=true 면 첫 지시의 응답까지 기다림",
          {"type": "object", "properties": {
              "name": {"type": "string"}, "prompt": {"type": "string"},
              "role": {"type": "string", "enum": ["worker", "master"]},
              "cwd": {"type": "string"}, "backend": {"type": "string", "enum": ["sdk", "tmux"]},
              "wait": {"type": "boolean"}, "timeout_s": {"type": "integer"}},
           "required": ["name"]})
    async def session_new(args: dict) -> dict:
        try:
            row = await mgr.facade.create(
                name=args["name"], role=args.get("role") or "worker", prompt=None,
                cwd=args.get("cwd") or sess.cwd, backend=args.get("backend") or "sdk",
                sdk=None, parent={"id": sess.id, "name": sess.name}, trust=True)
            out: dict[str, Any] = {"created": row.get("name"), "backend": row.get("backend"), "cwd": row.get("cwd")}
            if args.get("prompt"):
                res = await mgr.facade.send(args["name"], args["prompt"], wait=bool(args.get("wait")),
                                            timeout_s=args.get("timeout_s") or 600)
                out["send"] = res
        except Exception as e:
            return _text(f"실패: {e}", True)
        return _text(json.dumps(out, ensure_ascii=False, indent=1, default=str))

    @tool("session_send", "세션에 지시 보내기. wait=true 면 그 턴의 응답(last)까지 기다림",
          {"type": "object", "properties": {
              "name": {"type": "string"}, "text": {"type": "string"},
              "wait": {"type": "boolean"}, "timeout_s": {"type": "integer"}},
           "required": ["name", "text"]})
    async def session_send(args: dict) -> dict:
        if args["name"] == sess.name:
            return _text("자기 자신에게는 못 보냄", True)
        try:
            res = await mgr.facade.send(args["name"], args["text"], wait=args.get("wait", True),
                                        timeout_s=args.get("timeout_s") or 600)
        except Exception as e:
            return _text(f"실패: {e}", True)
        return _text(json.dumps(res, ensure_ascii=False, indent=1, default=str))

    @tool("session_report", "세션 결과 보고: 살아있는지, 작업중/완료, 마지막 턴 지시와 응답 전체",
          {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]})
    async def session_report(args: dict) -> dict:
        try:
            return _text(json.dumps(await mgr.facade.report(args["name"]), ensure_ascii=False, indent=1, default=str))
        except Exception as e:
            return _text(f"실패: {e}", True)

    @tool("session_kill", "세션 끝내기 (purge=true 면 기록도 삭제 표시)",
          {"type": "object", "properties": {"name": {"type": "string"}, "purge": {"type": "boolean"}},
           "required": ["name"]})
    async def session_kill(args: dict) -> dict:
        if args["name"] == sess.name:
            return _text("자기 자신은 못 끝냄", True)
        try:
            await mgr.facade.kill(args["name"], bool(args.get("purge")))
        except Exception as e:
            return _text(f"실패: {e}", True)
        return _text("끝냄")

    return create_sdk_mcp_server("cardinal", tools=[reply, session_list, session_new, session_send,
                                                    session_report, session_kill])


# ---------- 매니저 ----------


class SdkManager:
    def __init__(self, settings: Settings, db: DB, on_change: Callable[[], None]):
        self.settings = settings
        self.db = db
        self.on_change = on_change
        self.sessions: dict[str, SdkSession] = {}
        self.router: Any = None  # app 이 연결 (답장용)
        self.facade: Any = None  # app 이 연결 (마스터 도구가 tmux 세션도 다루게)
        self._create_locks: dict[str, asyncio.Lock] = {}
        self._changed_pending = False

    def changed(self) -> None:
        # 상태가 한꺼번에 여러 번 바뀌어도 /ws/events 는 한 번만
        if self._changed_pending:
            return
        self._changed_pending = True

        def fire():
            self._changed_pending = False
            self.on_change()

        asyncio.get_running_loop().call_later(0.05, fire)

    def get(self, name: str) -> SdkSession:
        s = self.sessions.get(name)
        if not s:
            raise LookupError(f"모르는 SDK 세션: {name}")
        return s

    async def startup(self) -> None:
        """지난번 서버가 남긴 sdk 세션: 프로세스는 이미 없으니 ended. resume_on_start 면 이어서 다시 띄움"""
        for row in self.db.sessions():
            if row.get("backend") != "sdk":
                continue
            sess = SdkSession(self, row)
            self.sessions[sess.name] = sess
            if row.get("alive") or row.get("state") != "ended":
                self.db.update_sdk_session(row["id"], alive=False, state="ended", state_at=now(),
                                           last_event="SessionEnd", detail="서버가 재시작됨 (restart 로 이어서 시작)")
            sess.state, sess.event = "ended", "SessionEnd"
            if (row.get("sdk_options") or {}).get("resume_on_start"):
                try:
                    await sess.start(resume=True)
                    log.info("SDK 세션 이어서 시작: %s", sess.name)
                except Exception as e:
                    log.warning("SDK 세션 %s 이어서 시작 실패: %s", sess.name, e)
        self.on_change()

    async def shutdown(self) -> None:
        await asyncio.gather(*(s.stop("서버 종료") for s in self.sessions.values() if s.alive),
                             return_exceptions=True)

    async def create(self, name: str, role: str, cwd: str, options: dict, parent: dict | None,
                     prompt: str | None) -> SdkSession:
        async with self._create_locks.setdefault(name, asyncio.Lock()):
            old = self.sessions.get(name)
            if old and old.alive:
                raise SdkError(f"이미 있는 세션 이름: {name}")
            if old:
                # 같은 이름의 끝난 세션 기록은 남기고 삭제 표시 (tmux 쪽과 같은 규칙)
                self.db.mark_deleted(old.id)
            row = {"id": str(uuid.uuid4()), "name": name, "role": role, "cwd": cwd, "created_at": now(),
                   "claude_session_id": None, "parent_id": (parent or {}).get("id"),
                   "parent_name": (parent or {}).get("name"), "sdk_options": options}
            self.db.insert_sdk_session(row)
            sess = SdkSession(self, self.db.session_by_id(row["id"]) or row)
            self.sessions[name] = sess
            try:
                await sess.start(resume=False)
            except SdkError:
                raise
        if prompt:
            # 첫 지시는 뒤에서 (만들기 요청이 응답 끝까지 안 붙잡히게)
            t = asyncio.create_task(self._first_prompt(sess, prompt))
            t.add_done_callback(lambda _: None)
        return sess

    async def _first_prompt(self, sess: SdkSession, prompt: str) -> None:
        try:
            await sess.send(prompt)
        except Exception as e:
            log.warning("[%s] 첫 지시 실패: %s", sess.name, e)

    async def restart(self, name: str, resume: bool = True, options: dict | None = None) -> SdkSession:
        sess = self.get(name)
        if sess.alive:
            await sess.stop("restart")
        if options:
            sess.options = {**sess.options, **options}
            self.db.update_sdk_session(sess.id, sdk_options=sess.options)
        sess.open_turns.clear()
        await sess.start(resume=resume)
        return sess

    async def kill(self, name: str, purge: bool = False) -> None:
        sess = self.get(name)
        if sess.alive:
            await sess.stop("kill")
        if purge:
            self.db.mark_deleted(sess.id)
            self.sessions.pop(name, None)
            self.on_change()
