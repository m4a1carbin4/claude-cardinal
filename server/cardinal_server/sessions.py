"""세션 제어 한 곳: 백엔드(tmux = cardinal CLI, sdk = 서버 안 SdkManager)를 이름으로 골라서 부름.

라우터(채널 전달), API, 마스터 도구가 다 이걸 써서 두 백엔드가 같은 규칙으로 돎.
"""

import os
import re
from pathlib import Path
from typing import Any

from .cli import Cli, CliError
from .config import Settings
from .db import DB
from .ingest import Ingestor
from .sdk import SdkError, SdkManager

# CLI(src/session.ts NAME_RE)와 같은 규칙
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$")


class SessionError(Exception):
    pass


class Sessions:
    def __init__(self, settings: Settings, db: DB, cli: Cli, ingestor: Ingestor, sdk: SdkManager | None):
        self.settings = settings
        self.db = db
        self.cli = cli
        self.ingestor = ingestor
        self.sdk = sdk

    def backend_of(self, name: str) -> str | None:
        row = self.db.session_by_name(name)
        return row["backend"] if row else None

    def _sdk(self):
        if not self.sdk:
            raise SessionError("SDK 모드가 꺼져 있음 (cardinal-server --sdk 또는 CARDINAL_SDK=1)")
        return self.sdk

    def sdk_session(self, name: str):
        """이 이름이 sdk 세션이면 그 세션, 아니면 에러"""
        if self.backend_of(name) != "sdk":
            raise SessionError(f"SDK 세션이 아님: {name}")
        try:
            return self._sdk().get(name)
        except LookupError as e:
            raise SessionError(str(e))

    def _resolve_cwd(self, cwd: str | None) -> str:
        if not cwd:
            self.settings.workspace.mkdir(parents=True, exist_ok=True)
            return os.path.realpath(self.settings.workspace)
        if not os.path.isabs(cwd):
            raise SessionError(f"cwd 는 절대 경로여야 함: {cwd}")
        if not Path(cwd).is_dir():
            raise SessionError(f"작업 폴더가 없거나 디렉터리가 아님: {cwd}")
        return os.path.realpath(cwd)

    async def create(self, *, name: str, role: str = "worker", prompt: str | None = None, cwd: str | None = None,
                     backend: str | None = None, sdk: dict | None = None, parent: dict | None = None,
                     trust: bool = False, args: list[str] | None = None) -> dict:
        backend = backend or ("sdk" if self.settings.sdk else "tmux")
        if not NAME_RE.match(name):
            raise SessionError(f"세션 이름 규칙 위반: {name} (영문/숫자/-/_ , 최대 48자)")
        existing = self.db.session_by_name(name)
        if backend == "sdk":
            if not self.settings.sdk:
                raise SessionError("SDK 모드가 꺼져 있음 (cardinal-server --sdk 또는 CARDINAL_SDK=1)")
            mgr = self._sdk()
            if args:
                raise SessionError("SDK 세션은 claude 인자(args) 대신 sdk 옵션을 씀")
            # 이름은 두 백엔드가 같이 씀. tmux 쪽 기록이 남아 있으면 그 이름은 못 씀 (어느 쪽인지 헷갈림)
            if existing and existing["backend"] == "tmux":
                raise SessionError(f"tmux 세션이 쓰는 이름: {name} (kill --purge 하고 다시)")
            if (self.settings.sessions_dir / name / "meta.json").exists():
                raise SessionError(f"tmux 세션 기록이 남아 있는 이름: {name} (cardinal kill {name} --purge)")
            try:
                sess = await mgr.create(name, role, self._resolve_cwd(cwd), dict(sdk or {}), parent, prompt)
            except SdkError as e:
                raise SessionError(str(e))
            return self.db.session_by_id(sess.id) or {}
        if backend != "tmux":
            raise SessionError(f"모르는 백엔드: {backend}")
        if sdk:
            raise SessionError("sdk 옵션은 backend=sdk 에서만")
        if cwd and not os.path.isabs(cwd):
            raise SessionError(f"cwd 는 절대 경로여야 함: {cwd}")
        if existing and existing["backend"] == "sdk":
            if existing["alive"]:
                raise SessionError(f"SDK 세션이 쓰는 이름: {name}")
            # 끝난 sdk 세션 이름은 넘겨받음 (기록은 삭제 표시로 남김)
            self._sdk().sessions.pop(name, None) if self.sdk else None
            self.db.mark_deleted(existing["id"])
        try:
            await self.cli.new(name, role, prompt, args or [], cwd=cwd, trust=trust, parent=parent)
        except CliError as e:
            raise SessionError(str(e))
        await self.ingestor.sync()
        return self.db.session_by_name(name) or {}

    async def send(self, name: str, text: str, *, wait: bool = False, timeout_s: float | None = None,
                   submit: bool = True, force: bool = False, now: bool = False) -> Any:
        if self.backend_of(name) == "sdk":
            if not submit:
                raise SessionError("SDK 세션엔 입력창이 없어서 붙여넣기만(submit=false)은 못 함")
            try:
                return await self.sdk_session(name).send(text, wait=wait, timeout_s=timeout_s, now_=now, force=force)
            except SdkError as e:
                raise SessionError(str(e))
        try:
            return await self.cli.send(name, text, wait=wait, timeout_s=int(timeout_s) if timeout_s else None,
                                       submit=submit, force=force, now=now)
        except CliError as e:
            raise SessionError(str(e))

    async def report(self, name: str) -> dict:
        if self.backend_of(name) == "sdk":
            return self.sdk_session(name).report()
        try:
            return await self.cli.json("report", name)
        except CliError as e:
            raise SessionError(str(e))

    async def kill(self, name: str, purge: bool = False) -> None:
        if self.backend_of(name) == "sdk":
            self.sdk_session(name)
            await self._sdk().kill(name, purge)
            return
        try:
            await self.cli.run("kill", name, *(["--purge"] if purge else []))
        except CliError as e:
            raise SessionError(str(e))
        await self.ingestor.sync()
