"""스테이지 음성(TTS, ZONOS3-Mini) 서버 쪽 (docs/stage.md 의 "목소리").

- 호스트 엔진: 이 컴퓨터의 zonos3-server(CPU ggml) 로 /v2/* 를 그대로 넘김 (스트리밍 PCM 은 받는 대로 흘려보냄, 쌓지 않음)
  CARDINAL_STAGE_TTS_CMD 가 있으면 카디널이 그 프로세스를 띄우고 끔 (이미 그 주소에서 답하면 안 띄움)
- 기기 엔진: 브라우저 WebGPU 엔진 파일(engine.js 등)과 모델 조각은 app.py 가 /stage-tts/engine, /stage-tts/models 로 내려줌
- 목소리 저장소: 목소리 디자인에서 "저장"한 목소리 (레시피 JSON + 참고 음성 wav + 화자 임베딩). 두 엔진 다 이걸로 씀
"""

import asyncio
import base64
import contextlib
import json
import logging
import re
import secrets
import shlex
import time
from pathlib import Path
from typing import Any

import aiohttp

from .config import Settings

log = logging.getLogger("cardinal.stage_tts")

# zonos3-server 의 음성 캐시는 X-TTS-Session-ID 별로 갈림. 스테이지는 브라우저가 몇 개든 한 세션을 같이 씀
HOST_SESSION = "cardinal-stage"
# 넘겨주는 경로 (그 밖의 /v2/* 는 막음: 편집·프로젝트 등은 스테이지에 필요 없음)
ALLOWED = re.compile(r"^v2/(generate|capabilities|controls|health|speakers(/[A-Za-z0-9_.-]+/(preview|embedding))?)$")
HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "content-length", "host",
       "content-encoding", "authorization", "cookie"}
MAX_CLIP_BYTES = 12 * 1024 * 1024  # 30초 44.1kHz 16비트 모노 wav ≈ 2.6MB, 넉넉히
VOICE_ID = re.compile(r"^[a-z0-9-]{1,40}$")


class TtsError(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status


class StageTts:
    def __init__(self, settings: Settings):
        self.s = settings
        self.voices_dir = settings.stage_tts_voices
        self._http: aiohttp.ClientSession | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._proc_log: Path = settings.home / "stage-tts" / "zonos3-server.log"
        self._starting: asyncio.Lock | None = None

    # ---------- 수명 ----------

    def http(self) -> aiohttp.ClientSession:
        if self._http is None or self._http.closed:
            # 긴 문장 스트림은 오래 걸릴 수 있음 → 전체 시간 제한 없이, 연결·읽기만 제한
            self._http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, connect=5, sock_read=120))
        return self._http

    async def startup(self) -> None:
        if self.s.stage_tts_cmd and self.s.stage_tts_url:
            asyncio.get_running_loop().create_task(self.ensure_host())

    async def shutdown(self) -> None:
        if self._http:
            await self._http.close()
        p = self._proc
        if p and p.returncode is None:
            log.info("zonos3-server 끔 (pid %s)", p.pid)
            p.terminate()
            try:
                await asyncio.wait_for(p.wait(), 5)
            except TimeoutError:
                p.kill()

    async def host_alive(self) -> bool:
        if not self.s.stage_tts_url:
            return False
        try:
            async with self.http().get(f"{self.s.stage_tts_url}/v2/health", timeout=aiohttp.ClientTimeout(total=2)) as r:
                return r.status == 200
        except (aiohttp.ClientError, TimeoutError, OSError):
            return False

    async def ensure_host(self) -> bool:
        """호스트 엔진이 답하는지. 안 답하고 CARDINAL_STAGE_TTS_CMD 가 있으면 띄우고 기다림 (모델 읽기에 몇 초)"""
        if await self.host_alive():
            return True
        if not self.s.stage_tts_cmd:
            return False
        self._starting = self._starting or asyncio.Lock()
        async with self._starting:
            if await self.host_alive():
                return True
            if not self._proc or self._proc.returncode is not None:
                self._proc_log.parent.mkdir(parents=True, exist_ok=True)
                out = open(self._proc_log, "ab")  # noqa: SIM115 (프로세스가 들고 감)
                cwd = self.s.stage_tts_cwd
                log.info("zonos3-server 띄움: %s (cwd %s)", self.s.stage_tts_cmd, cwd)
                try:
                    self._proc = await asyncio.create_subprocess_exec(
                        *shlex.split(self.s.stage_tts_cmd), cwd=str(cwd) if cwd else None,
                        stdout=out, stderr=asyncio.subprocess.STDOUT, stdin=asyncio.subprocess.DEVNULL)
                except OSError as e:
                    log.warning("zonos3-server 를 못 띄움: %s", e)
                    return False
                finally:
                    out.close()
            for _ in range(120):
                if self._proc.returncode is not None:
                    log.warning("zonos3-server 가 바로 꺼짐 (코드 %s, 로그 %s)", self._proc.returncode, self._proc_log)
                    return False
                if await self.host_alive():
                    return True
                await asyncio.sleep(0.5)
            return False

    async def status(self) -> dict[str, Any]:
        engine = self.s.stage_tts_engine / "engine.js"
        models = self.s.stage_tts_models
        return {
            "host": {
                "url": bool(self.s.stage_tts_url),
                "ok": await self.host_alive(),
                "managed": bool(self.s.stage_tts_cmd),
                "running": bool(self._proc and self._proc.returncode is None),
            },
            "device": {
                "engine": engine.is_file(),
                "models": (models / "backbone" / "manifest.json").is_file() and (models / "zac" / "manifest.json").is_file(),
                # 올린 음성을 기기에서 화자로 바꾸려면 encoder+teacher(~2.7GB)가 필요. 없으면 기기에선 임베딩만 씀
                "upload": (models / "encoder" / "manifest.json").is_file(),
            },
        }

    # ---------- 호스트 엔진으로 넘기기 ----------

    async def open_upstream(self, method: str, path: str, query: str, headers: dict[str, str], body: bytes | None):
        """zonos3-server 에 요청을 보내고 (응답, 정리 함수) 를 돌려줌. 응답 본문은 부른 쪽이 흘려보냄"""
        if not ALLOWED.match(path):
            raise TtsError(404, f"넘기지 않는 경로: /{path}")
        if not self.s.stage_tts_url:
            raise TtsError(503, "호스트 TTS 꺼짐 (CARDINAL_STAGE_TTS_URL 비어 있음)")
        if not await self.ensure_host():
            raise TtsError(503, f"호스트 TTS(zonos3-server)가 답하지 않음: {self.s.stage_tts_url}")
        hdrs = {k: v for k, v in headers.items() if k.lower() not in HOP and not k.lower().startswith("x-tts-")}
        hdrs["X-TTS-Session-ID"] = HOST_SESSION
        url = f"{self.s.stage_tts_url}/{path}" + (f"?{query}" if query else "")
        try:
            r = await self.http().request(method, url, data=body, headers=hdrs)
        except (aiohttp.ClientError, OSError) as e:
            raise TtsError(502, f"zonos3-server 연결 실패: {e}")
        return r

    # ---------- 목소리 저장소 ----------

    def _vdir(self, vid: str) -> Path:
        if not VOICE_ID.match(vid):
            raise TtsError(404, f"모르는 목소리: {vid}")
        return self.voices_dir / vid

    def _active_file(self) -> Path:
        return self.voices_dir / "active.json"

    def active(self) -> str | None:
        with contextlib.suppress(OSError, ValueError):
            vid = json.loads(self._active_file().read_text()).get("id")
            if vid and (self.voices_dir / vid / "voice.json").is_file():
                return vid
        return None

    def set_active(self, vid: str | None) -> None:
        if vid is not None and not (self._vdir(vid) / "voice.json").is_file():
            raise TtsError(404, f"모르는 목소리: {vid}")
        self.voices_dir.mkdir(parents=True, exist_ok=True)
        self._active_file().write_text(json.dumps({"id": vid}))

    def list_voices(self) -> dict[str, Any]:
        out = []
        if self.voices_dir.is_dir():
            for d in self.voices_dir.iterdir():
                f = d / "voice.json"
                if d.is_dir() and f.is_file():
                    with contextlib.suppress(OSError, ValueError):
                        out.append(json.loads(f.read_text()))
        out.sort(key=lambda v: v.get("created_at", 0))
        return {"voices": out, "active": self.active()}

    def get_voice(self, vid: str) -> dict[str, Any]:
        f = self._vdir(vid) / "voice.json"
        if not f.is_file():
            raise TtsError(404, f"모르는 목소리: {vid}")
        return json.loads(f.read_text())

    def clip_path(self, vid: str) -> Path:
        f = self._vdir(vid) / "reference.wav"
        if not f.is_file():
            raise TtsError(404, "참고 음성 없음")
        return f

    def save_voice(self, recipe: dict[str, Any], clip_b64: str | None) -> dict[str, Any]:
        """레시피(+참고 음성 wav) 저장. 같은 id 를 주면 덮어씀(고치기)"""
        name = str(recipe.get("name") or "").strip()[:60]
        if not name:
            raise TtsError(400, "이름이 필요함")
        emb = recipe.get("embedding")
        if emb is not None and (not isinstance(emb, list) or not 16 <= len(emb) <= 4096
                                or not all(isinstance(x, (int, float)) for x in emb)):
            raise TtsError(400, "embedding 은 숫자 목록이어야 함")
        clip: bytes | None = None
        if clip_b64:
            try:
                clip = base64.b64decode(clip_b64.split(",", 1)[-1], validate=True)
            except ValueError:
                raise TtsError(400, "clip 이 base64 가 아님")
            if len(clip) > MAX_CLIP_BYTES or clip[:4] != b"RIFF" or clip[8:12] != b"WAVE":
                raise TtsError(400, "clip 은 wav (30초 이하) 여야 함")
        vid = str(recipe.get("id") or "")
        old: dict[str, Any] = {}
        if vid:
            old = self.get_voice(vid)
        else:
            vid = f"v-{time.strftime('%y%m%d')}-{secrets.token_hex(3)}"
        d = self._vdir(vid)
        d.mkdir(parents=True, exist_ok=True)
        if clip is not None:
            (d / "reference.wav").write_bytes(clip)
        source = recipe.get("source") if isinstance(recipe.get("source"), dict) else {"type": "default"}
        if source.get("type") == "clip" and not (d / "reference.wav").is_file():
            raise TtsError(400, "참고 음성으로 만든 목소리엔 clip 이 필요함")
        keep = ("language", "speaker_mode", "condition_values", "controls", "params", "test_text")
        v = {
            **{k: recipe[k] for k in keep if k in recipe},
            "id": vid,
            "name": name,
            "source": source,
            "embedding": emb,
            "has_clip": (d / "reference.wav").is_file(),
            "created_at": old.get("created_at", time.time()),
            "updated_at": time.time(),
        }
        (d / "voice.json").write_text(json.dumps(v, ensure_ascii=False))
        return v

    def delete_voice(self, vid: str) -> None:
        d = self._vdir(vid)
        if not d.is_dir():
            raise TtsError(404, f"모르는 목소리: {vid}")
        for f in d.iterdir():
            f.unlink()
        d.rmdir()
        if self.active() is None:
            with contextlib.suppress(OSError):
                self._active_file().unlink()
