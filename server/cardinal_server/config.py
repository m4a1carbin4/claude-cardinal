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
    slack_bot_token: str | None  # xoxb-, API 호출
    slack_app_token: str | None  # xapp-, Socket Mode 접속
    sdk: bool  # CARDINAL_SDK=1 (cardinal-server --sdk): 서버 안 Claude Agent SDK 세션 사용 + 새 세션 기본 백엔드
    workspace: Path  # 작업 폴더를 안 주면 쓰는 고정 워크스페이스 (CLI 와 같은 곳)
    drive: Path  # 웹드라이브 (사람·세션이 같이 쓰는 파일 공간, drive.py)
    drive_max_upload: int  # 웹에서 올리는 파일 하나 한도 (바이트)
    admin: str | None  # 관리자 세션 이름 (CARDINAL_ADMIN, 기본 cardinal). SDK 모드에서 서버가 띄우는 마스터. None = 끔
    stage_assets: Path  # 스테이지 페이지(/stage) 캐릭터·배경 파일 (CARDINAL_STAGE_ASSETS). 저장소엔 안 넣음
    # 스테이지 음성 (ZONOS3-Mini, docs/stage.md "목소리")
    stage_tts_url: str  # 호스트 엔진 zonos3-server 주소 (CARDINAL_STAGE_TTS_URL, 기본 http://127.0.0.1:1919, 빈 값 = 끔)
    stage_tts_cmd: str | None  # 있으면 카디널이 이 명령으로 zonos3-server 를 띄우고 끔 (CARDINAL_STAGE_TTS_CMD)
    stage_tts_cwd: Path | None  # 위 명령의 작업 폴더 (CARDINAL_STAGE_TTS_CWD)
    stage_tts_engine: Path  # 기기 엔진 파일 engine.js·worker.js·codec-worker.js (CARDINAL_STAGE_TTS_ENGINE)
    stage_tts_models: Path  # 기기 엔진 모델 조각 (HF Zyphra/ZONOS3-Mini 의 web/, CARDINAL_STAGE_TTS_MODELS)
    stage_tts_voices: Path  # 저장한 목소리 (CARDINAL_STAGE_TTS_VOICES)

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


def _admin_name(v: str) -> str | None:
    v = v.strip()
    return None if v.lower() in ("", "0", "false", "off") else v


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
        slack_bot_token=os.environ.get("SLACK_BOT_TOKEN") or None,
        slack_app_token=os.environ.get("SLACK_APP_TOKEN") or None,
        sdk=os.environ.get("CARDINAL_SDK", "") not in ("", "0", "false"),
        workspace=Path(os.environ.get("CARDINAL_WORKSPACE", home / "workspace")).expanduser(),
        drive=Path(os.environ.get("CARDINAL_DRIVE", home / "drive")).expanduser(),
        drive_max_upload=int(os.environ.get("CARDINAL_DRIVE_MAX_MB", "1024")) * 1024 * 1024,
        admin=_admin_name(os.environ.get("CARDINAL_ADMIN", "cardinal")),
        stage_assets=Path(os.environ.get("CARDINAL_STAGE_ASSETS", home / "stage-assets")).expanduser(),
        stage_tts_url=os.environ.get("CARDINAL_STAGE_TTS_URL", "http://127.0.0.1:1919").strip().rstrip("/"),
        stage_tts_cmd=os.environ.get("CARDINAL_STAGE_TTS_CMD") or None,
        stage_tts_cwd=Path(os.environ["CARDINAL_STAGE_TTS_CWD"]).expanduser() if os.environ.get("CARDINAL_STAGE_TTS_CWD") else None,
        stage_tts_engine=Path(os.environ.get("CARDINAL_STAGE_TTS_ENGINE", home / "stage-tts" / "engine")).expanduser(),
        stage_tts_models=Path(os.environ.get("CARDINAL_STAGE_TTS_MODELS", home / "stage-tts" / "models")).expanduser(),
        stage_tts_voices=Path(os.environ.get("CARDINAL_STAGE_TTS_VOICES", home / "stage-tts" / "voices")).expanduser(),
    )
