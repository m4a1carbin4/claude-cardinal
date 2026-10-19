"""환경변수 → 설정. CLI(TS)랑 같은 이름 씀."""

import os
from dataclasses import dataclass
from pathlib import Path

# server/cardinal_server/config.py → 저장소 루트
REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    home: Path  # CARDINAL_HOME, CLI랑 공유
    cli: Path  # cardinal CLI 경로
    db_path: Path
    inbox: Path  # 채널 이벤트 첨부파일 받아두는 곳
    host: str
    port: int
    token: str | None  # 있으면 HTTP/WS 전부 인증
    discord_token: str | None

    @property
    def sessions_dir(self) -> Path:
        return self.home / "sessions"

    @property
    def hooks_dir(self) -> Path:
        return self.home / "hooks"

    @property
    def url(self) -> str:
        host = "127.0.0.1" if self.host in ("0.0.0.0", "::") else self.host
        return f"http://{host}:{self.port}"


def load() -> Settings:
    home = Path(os.environ.get("CARDINAL_HOME", Path.home() / ".cardinal")).expanduser()
    return Settings(
        home=home,
        cli=Path(os.environ.get("CARDINAL_CLI", REPO_ROOT / "bin" / "cardinal")),
        db_path=Path(os.environ.get("CARDINAL_DB", home / "cardinal.db")),
        inbox=home / "inbox",
        host=os.environ.get("CARDINAL_HOST", "127.0.0.1"),
        port=int(os.environ.get("CARDINAL_PORT", "7878")),
        token=os.environ.get("CARDINAL_TOKEN") or None,
        discord_token=os.environ.get("DISCORD_TOKEN") or None,
    )
