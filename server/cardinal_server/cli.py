"""cardinal CLI(TS) 호출 래퍼. 세션 제어 로직은 CLI 한 곳에만 둠."""

import asyncio
import json
import os
from typing import Any

from .config import Settings


# send 가 세션 락 + idle 을 기다리는 최대 시간
QUEUE_TIMEOUT_S = 600


class CliError(Exception):
    pass


class Cli:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.env = {**os.environ, "CARDINAL_HOME": str(settings.home)}

    async def run(self, *args: str, stdin: str | None = None, timeout: float | None = 60) -> str:
        proc = await asyncio.create_subprocess_exec(
            str(self.settings.cli),
            *args,
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self.env,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(stdin.encode() if stdin is not None else None), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise CliError(f"cardinal {args[0]} 시간 초과")
        if proc.returncode != 0:
            raise CliError(err.decode().strip().removeprefix("cardinal: ") or f"exit {proc.returncode}")
        return out.decode()

    async def json(self, *args: str, **kw: Any) -> Any:
        return json.loads(await self.run(*args, "--json", **kw))

    # 자주 쓰는 것들

    async def new(self, name: str, role: str = "worker", prompt: str | None = None, claude_args: list[str] | None = None):
        args = ["new", name, "--role", role]
        if prompt:
            args += ["--prompt", prompt]
        args += ["--json"]
        if claude_args:
            args += ["--", *claude_args]
        return json.loads(await self.run(*args))

    async def send(self, name: str, text: str, *, wait: bool = False, timeout_s: int | None = None,
                   submit: bool = True, force: bool = False, now: bool = False,
                   queue_timeout_s: int = QUEUE_TIMEOUT_S) -> Any:
        # 텍스트는 항상 stdin으로. 인자로 넘기면 '-'로 시작하는 텍스트를 옵션으로 오해함
        args = ["send", name, "-", "--queue-timeout", str(queue_timeout_s)]
        if wait:
            args.append("--wait")
        if timeout_s:
            args += ["--timeout", str(timeout_s)]
        if not submit:
            args.append("--no-enter")
        if force:
            args.append("--force")
        if now:
            args.append("--now")
        # CLI 쪽에서 세션 락 + idle 대기(최대 queue_timeout_s)를 하니까 그만큼 더 기다려줌
        limit = queue_timeout_s + (timeout_s or 0) + 30 if (timeout_s or not wait) else None
        return await self.json(*args, stdin=text, timeout=limit)
