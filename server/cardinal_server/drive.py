"""웹드라이브: 사람(웹 UI)과 세션(모델)이 같이 쓰는 파일 공간.

CARDINAL_HOME/drive (CARDINAL_DRIVE 로 바꿈) 아래:
- /shared            다 같이 쓰는 곳
- /sessions/<이름>    세션마다 하나. 세션을 만들면 생김. 사람이 요청에 붙인 첨부는 그 안 attachments/ 에 저장
드라이브 경로는 항상 / 로 시작하는 드라이브 기준 경로. 세션 도구에서 / 없이 쓰면 그 세션 폴더 기준.
"""

from __future__ import annotations  # 메서드 list 가 클래스 안에서 내장 list 를 가림

import mimetypes
import os
import posixpath
import shutil
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

SHARED = "/shared"
SESSIONS = "/sessions"
ATTACHMENTS = "attachments"
CHUNK = 1024 * 1024
MAX_TEXT_BYTES = 2 * 1024 * 1024  # 글로 읽고 쓰는 파일 한도 (웹 편집기, 세션 drive_read/drive_write)


class DriveError(Exception):
    pass


class Drive:
    def __init__(self, root: Path, max_upload_bytes: int, on_change: Callable[[str], None] | None = None):
        root.mkdir(parents=True, exist_ok=True)
        self.root = Path(os.path.realpath(root))
        self.max_upload_bytes = max_upload_bytes
        self.on_change = on_change  # 바뀐 폴더의 드라이브 경로를 알림 (/ws/events 로)
        for d in (SHARED, SESSIONS):
            self.local(d).mkdir(parents=True, exist_ok=True)

    # ---------- 경로 ----------

    @staticmethod
    def norm(path: str, base: str = "/") -> str:
        """드라이브 경로 정리. / 없이 시작하면 base 기준. 루트 밖(..)으로 나가면 에러"""
        path = (path or "").replace("\\", "/").strip()
        joined = path if path.startswith("/") else posixpath.join(base or "/", path)
        parts: list[str] = []
        for p in joined.split("/"):
            if p in ("", "."):
                continue
            if p == "..":
                if not parts:
                    raise DriveError(f"드라이브 밖 경로: {path}")
                parts.pop()
                continue
            parts.append(p)
        return "/" + "/".join(parts)

    def local(self, path: str, base: str = "/") -> Path:
        """드라이브 경로 → 실제 경로. 심볼릭 링크로 드라이브 밖을 가리키는 것도 막음"""
        p = self.root / self.norm(path, base).lstrip("/")
        real = Path(os.path.realpath(p))
        if real != self.root and self.root not in real.parents:
            raise DriveError(f"드라이브 밖을 가리킴: {path}")
        return p

    def drive_path(self, local: Path) -> str:
        real = Path(os.path.realpath(local))
        if real != self.root and self.root not in real.parents:
            raise DriveError(f"드라이브 안이 아님: {local}")
        return "/" + real.relative_to(self.root).as_posix() if real != self.root else "/"

    @staticmethod
    def session_path(name: str) -> str:
        return f"{SESSIONS}/{name}"

    def ensure_session(self, name: str) -> Path:
        d = self.local(self.session_path(name))
        d.mkdir(parents=True, exist_ok=True)
        return d

    def protected(self, path: str) -> bool:
        """지우기/옮기기 안 되는 자리: 루트, /shared, /sessions, /sessions/<이름>"""
        p = self.norm(path)
        return p in ("/", SHARED, SESSIONS) or (p.startswith(SESSIONS + "/") and p.count("/") == 2)

    def _changed(self, *paths: str) -> None:
        if not self.on_change:
            return
        for d in {posixpath.dirname(p) or "/" for p in paths}:
            self.on_change(d)

    # ---------- 읽기 ----------

    def entry(self, local: Path) -> dict[str, Any]:
        st = local.stat()
        is_dir = local.is_dir()
        return {
            "name": local.name or "/",
            "path": self.drive_path(local),
            "type": "dir" if is_dir else "file",
            "size": None if is_dir else st.st_size,
            "mtime": st.st_mtime,
            "content_type": None if is_dir else mimetypes.guess_type(local.name)[0],
            "local_path": str(local),
        }

    def list(self, path: str = "/", base: str = "/") -> dict[str, Any]:
        d = self.local(path, base)
        if not d.exists():
            raise DriveError(f"없음: {self.norm(path, base)}")
        if not d.is_dir():
            raise DriveError(f"폴더가 아님: {self.norm(path, base)}")
        entries = []
        for c in d.iterdir():
            if c.name.startswith(".cardinal-up-"):  # 올리는 중인 임시 파일
                continue
            try:
                entries.append(self.entry(c))
            except (OSError, DriveError):  # 깨진 링크, 밖을 가리키는 링크
                continue
        entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
        return {**self.entry(d), "entries": entries}

    def file(self, path: str) -> Path:
        f = self.local(path)
        if not f.is_file():
            raise DriveError(f"파일이 없음: {self.norm(path)}")
        return f

    def read_text(self, path: str, base: str = "/") -> dict[str, Any]:
        f = self.local(path, base)
        if not f.is_file():
            raise DriveError(f"파일이 없음: {self.norm(path, base)}")
        if f.stat().st_size > MAX_TEXT_BYTES:
            raise DriveError(f"글로 읽기엔 너무 큼 (> {MAX_TEXT_BYTES // (1024 * 1024)}MB): {self.norm(path, base)}")
        try:
            content = f.read_bytes().decode("utf-8")
        except UnicodeDecodeError:
            raise DriveError(f"UTF-8 글 파일이 아님 (바이너리는 받기/drive_load 로): {self.norm(path, base)}")
        return {**self.entry(f), "content": content}

    # ---------- 쓰기 ----------

    def write_text(self, path: str, content: str, base: str = "/", overwrite: bool = True) -> dict[str, Any]:
        """글 파일 만들기/고치기. 폴더는 알아서 만듦. overwrite=False 면 있을 때 에러"""
        data = content.encode("utf-8")
        if len(data) > MAX_TEXT_BYTES:
            raise DriveError(f"너무 김 (> {MAX_TEXT_BYTES // (1024 * 1024)}MB)")
        f = self.local(path, base)
        if self.norm(path, base) == "/" or f.is_dir():
            raise DriveError(f"폴더임: {self.norm(path, base)}")
        if f.exists() and not overwrite:
            raise DriveError(f"이미 있음: {self.norm(path, base)}")
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.parent / f".cardinal-up-{os.getpid()}-{time.monotonic_ns()}"
        try:
            tmp.write_bytes(data)
            os.replace(tmp, f)
        finally:
            tmp.unlink(missing_ok=True)
        e = self.entry(f)
        self._changed(e["path"])
        return e

    @staticmethod
    def unique(dest: Path) -> Path:
        """같은 이름이 있으면 'a (1).txt' 처럼"""
        if not dest.exists():
            return dest
        stem, suffix = dest.stem, dest.suffix
        for i in range(1, 10_000):
            c = dest.with_name(f"{stem} ({i}){suffix}")
            if not c.exists():
                return c
        raise DriveError(f"이름을 못 정함: {dest.name}")

    @staticmethod
    def safe_name(name: str) -> str:
        name = os.path.basename((name or "").replace("\\", "/")).strip()
        name = "".join(c for c in name if c.isprintable())
        if name in ("", ".", ".."):
            return "file"
        return name[:200]

    async def save_upload(self, dir_path: str, filename: str, read, overwrite: bool = False) -> dict[str, Any]:
        """업로드 스트림(read(n) 코루틴)을 dir_path 안에 저장. 한도를 넘으면 지우고 에러"""
        d = self.local(dir_path)
        d.mkdir(parents=True, exist_ok=True)
        dest = d / self.safe_name(filename)
        if not overwrite:
            dest = self.unique(dest)
        tmp = d / f".cardinal-up-{os.getpid()}-{time.monotonic_ns()}"
        size = 0
        try:
            with open(tmp, "wb") as f:
                while chunk := await read(CHUNK):
                    size += len(chunk)
                    if size > self.max_upload_bytes:
                        raise DriveError(f"파일이 너무 큼 (> {self.max_upload_bytes // (1024 * 1024)}MB): {filename}")
                    f.write(chunk)
            os.replace(tmp, dest)
        finally:
            tmp.unlink(missing_ok=True)
        e = self.entry(dest)
        self._changed(e["path"])
        return e

    def mkdir(self, path: str, base: str = "/") -> dict[str, Any]:
        d = self.local(path, base)
        if d.exists() and not d.is_dir():
            raise DriveError(f"같은 이름의 파일이 있음: {self.norm(path, base)}")
        d.mkdir(parents=True, exist_ok=True)
        e = self.entry(d)
        self._changed(e["path"])
        return e

    def move(self, src: str, dst: str, overwrite: bool = False, base: str = "/") -> dict[str, Any]:
        """드라이브 안에서 옮기기/이름 바꾸기. dst 가 있는 폴더면 그 안으로"""
        src = self.norm(src, base)
        s, d = self.local(src), self.local(dst, base)
        if not s.exists():
            raise DriveError(f"없음: {self.norm(src)}")
        if self.protected(src):
            raise DriveError(f"옮길 수 없는 폴더: {self.norm(src)}")
        if d.is_dir():
            d = d / s.name
        if Path(os.path.realpath(d)) == Path(os.path.realpath(s)):
            return self.entry(s)
        if s.is_dir() and Path(os.path.realpath(s)) in Path(os.path.realpath(d)).parents:
            raise DriveError("폴더를 자기 안으로 옮길 수 없음")
        if d.exists():
            if not overwrite:
                raise DriveError(f"이미 있음: {self.drive_path(d)}")
            if d.is_dir():
                raise DriveError(f"폴더는 덮어쓸 수 없음: {self.drive_path(d)}")
        d.parent.mkdir(parents=True, exist_ok=True)
        old = self.drive_path(s)
        shutil.move(s, d)
        e = self.entry(d)
        self._changed(old, e["path"])
        return e

    def delete(self, path: str, recursive: bool = False, base: str = "/") -> None:
        path = self.norm(path, base)
        p = self.local(path)
        if self.protected(path):
            raise DriveError(f"지울 수 없는 폴더: {path}")
        if not p.exists() and not p.is_symlink():
            raise DriveError(f"없음: {path}")
        if p.is_dir() and not p.is_symlink():
            if any(p.iterdir()) and not recursive:
                raise DriveError(f"비어 있지 않은 폴더 (recursive=true 로): {self.norm(path)}")
            shutil.rmtree(p)
        else:
            p.unlink()
        self._changed(self.norm(path))

    # ---------- 세션 쪽 (로컬 파일 ↔ 드라이브) ----------

    def upload_local(self, src: Path, path: str, base: str, keep_source: bool = False,
                     overwrite: bool = False) -> dict[str, Any]:
        """로컬 파일/폴더를 드라이브로 옮김 (keep_source 면 복사). path 가 비었거나 / 로 끝나거나 있는 폴더면 그 안으로"""
        if not src.exists():
            raise DriveError(f"로컬 파일이 없음: {src}")
        if self.root in Path(os.path.realpath(src)).parents or Path(os.path.realpath(src)) == self.root:
            # 이미 드라이브 안이면 드라이브 안 옮기기와 같음
            if keep_source:
                raise DriveError("드라이브 안 파일은 keep_source 없이 옮기거나 drive_load 로 복사")
            return self.move(self.drive_path(src), path or ".", overwrite, base)
        d = self.local(path or ".", base)
        if not path or path.endswith("/") or d.is_dir():
            d.mkdir(parents=True, exist_ok=True)
            d = d / self.safe_name(src.name)
        if d.exists():
            if not overwrite:
                raise DriveError(f"이미 있음: {self.drive_path(d)} (overwrite=true 로 덮어쓰기)")
            if d.is_dir():
                raise DriveError(f"폴더는 덮어쓸 수 없음: {self.drive_path(d)}")
        d.parent.mkdir(parents=True, exist_ok=True)
        if keep_source:
            if src.is_dir():
                shutil.copytree(src, d)
            else:
                shutil.copy2(src, d)
        else:
            shutil.move(src, d)
        e = self.entry(d)
        self._changed(e["path"])
        return e

    def load_local(self, path: str, base: str, dest: Path, overwrite: bool = False) -> Path:
        """드라이브 파일/폴더를 로컬로 복사. dest 가 있는 폴더면 그 안으로"""
        s = self.local(path, base)
        if not s.exists():
            raise DriveError(f"드라이브에 없음: {self.norm(path, base)}")
        if dest.is_dir():
            dest = dest / s.name
        if dest.exists():
            if not overwrite:
                raise DriveError(f"로컬에 이미 있음: {dest} (overwrite=true 로 덮어쓰기)")
            if dest.is_dir():
                raise DriveError(f"로컬 폴더는 덮어쓸 수 없음: {dest}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        if s.is_dir():
            shutil.copytree(s, dest)
        else:
            shutil.copy2(s, dest)
        return dest

    # ---------- 요청 첨부 ----------

    def attachment_entries(self, paths: list[str]) -> list[dict[str, Any]]:
        out = []
        for p in paths:
            f = self.local(p)
            if not f.exists():
                raise DriveError(f"첨부 파일이 드라이브에 없음: {self.norm(p)}")
            out.append(self.entry(f))
        return out

    @staticmethod
    def attachment_note(entries: list[dict[str, Any]]) -> str:
        """세션에 보내는 지시 뒤에 붙는 첨부 안내 (tmux / SDK 같은 글)"""
        if not entries:
            return ""
        lines = [f"[첨부 {len(entries)}개 — 카디널 웹드라이브. 로컬 경로를 바로 읽거나 mcp__cardinal__drive_load 로 작업 폴더에 복사]"]
        for e in entries:
            if e["type"] == "dir":
                info = "폴더"
            else:
                size = e["size"] or 0
                info = ", ".join(x for x in (e.get("content_type"), f"{size / 1024:.0f}KB" if size < 1024 * 1024
                                             else f"{size / 1024 / 1024:.1f}MB") if x)
            lines.append(f"- {e['path']} ({info}) → {e['local_path']}")
        return "\n".join(lines)
