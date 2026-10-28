import argparse
import logging
import os
import sys

import uvicorn


def main() -> None:
    p = argparse.ArgumentParser(prog="cardinal-server", description="카디널 서버")
    p.add_argument("--host", help="기본 127.0.0.1 (CARDINAL_HOST)")
    p.add_argument("--port", type=int, help="기본 7878 (CARDINAL_PORT)")
    p.add_argument("--sdk", action="store_true",
                   help="SDK 모드: 세션을 서버 안의 Claude Agent SDK 로 돌림 (tmux 없이). 새 세션 기본 백엔드가 sdk (CARDINAL_SDK=1)")
    a = p.parse_args()
    if a.host:
        os.environ["CARDINAL_HOST"] = a.host
    if a.port:
        os.environ["CARDINAL_PORT"] = str(a.port)
    if a.sdk:
        os.environ["CARDINAL_SDK"] = "1"

    from .app import create_app
    from .config import load
    from .running import precheck

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    s = load()
    # 이미 떠 있는 서버/포트 먼저 확인. 확인 없이 띄우면 실패하면서 살아있는 서버의 server.json 을 지웠음
    if reason := precheck(s):
        print(f"cardinal-server: 시작 안 함 — {reason}", file=sys.stderr)
        sys.exit(1)
    # 오래 걸리는 요청(카디널 MCP 의 session_wait 등)이 있어도 종료가 몇 초 안에 SDK 세션 정리로 넘어가게
    uvicorn.run(create_app(s), host=s.host, port=s.port, log_level="info", timeout_graceful_shutdown=5)


if __name__ == "__main__":
    main()
