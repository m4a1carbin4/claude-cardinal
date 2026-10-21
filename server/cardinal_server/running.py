"""서버 중복 실행 확인.

같은 CARDINAL_HOME 으로 서버가 이미 떠 있는데 또 띄우면, 새 서버가 server.json 을 덮어쓰고
포트 충돌로 죽으면서 지워버려서 살아있는 서버로 cardinal reply 가 안 됐음. 그래서 시작 전에 먼저 확인.
"""

import json
import os
import socket

from .config import Settings


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:  # 살아있는데 권한만 없음
        return True
    except (ProcessLookupError, OSError):
        return False


def server_info(settings: Settings) -> dict | None:
    try:
        return json.loads((settings.home / "server.json").read_text())
    except (OSError, ValueError):
        return None


def running_elsewhere(settings: Settings) -> str | None:
    """다른 서버가 이 HOME 을 쓰고 있으면 그 설명. 없으면 None (죽은 서버가 남긴 server.json 은 무시)"""
    info = server_info(settings)
    if info and info.get("pid") and info["pid"] != os.getpid() and _pid_alive(int(info["pid"])):
        return f"카디널 서버가 이미 떠 있음: pid {info['pid']}, {info.get('url')} (CARDINAL_HOME={settings.home})"
    return None


def port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return False
        except OSError:
            return True


def precheck(settings: Settings) -> str | None:
    """시작해도 되면 None, 안 되면 이유"""
    if reason := running_elsewhere(settings):
        return reason
    if port_in_use(settings.host, settings.port):
        return f"포트 {settings.host}:{settings.port} 를 다른 프로세스가 쓰고 있음 (--port 로 다른 포트 지정)"
    return None

