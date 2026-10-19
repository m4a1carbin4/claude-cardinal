"""웹 터미널: 웹소켓 ↔ pty 안의 `tmux attach-session`.

프로토콜은 Node 서버 때랑 같음 (docs/web-terminal.md).
  client → server: 텍스트 JSON  {"t":"i","d":"입력"} | {"t":"r","c":cols,"r":rows}
  server → client: 바이너리 = 터미널 raw 출력
"""

import asyncio
import contextlib
import json
import os

from fastapi import WebSocket, WebSocketDisconnect
from ptyprocess import PtyProcess


async def bridge(ws: WebSocket, tmux_name: str, cols: int, rows: int, readonly: bool) -> None:
    args = ["tmux", "attach-session", "-t", f"={tmux_name}"]
    if readonly:
        # 입력 무시 + 이 클라이언트 크기는 창 크기 계산에서 빼기 (관전 모드)
        args += ["-r", "-f", "ignore-size"]
    proc = PtyProcess.spawn(args, dimensions=(rows, cols), env={**os.environ, "TERM": "xterm-256color"})

    loop = asyncio.get_running_loop()
    out: asyncio.Queue[bytes] = asyncio.Queue()

    def on_readable() -> None:
        try:
            data = os.read(proc.fd, 65536)
        except OSError:  # tmux 클라이언트 종료 (EIO)
            data = b""
        if not data:
            loop.remove_reader(proc.fd)
        out.put_nowait(data)

    loop.add_reader(proc.fd, on_readable)

    async def pump_out() -> None:
        while data := await out.get():
            await ws.send_bytes(data)
        with contextlib.suppress(Exception):
            await ws.close(code=1000, reason="detached")

    async def pump_in() -> None:
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if msg.get("t") == "i" and not readonly and isinstance(msg.get("d"), str):
                    os.write(proc.fd, msg["d"].encode())
                elif msg.get("t") == "r" and msg.get("c", 0) > 0 and msg.get("r", 0) > 0:
                    proc.setwinsize(int(msg["r"]), int(msg["c"]))
        except WebSocketDisconnect:
            pass

    tasks = [asyncio.create_task(pump_out()), asyncio.create_task(pump_in())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        with contextlib.suppress(Exception):
            loop.remove_reader(proc.fd)
        # tmux 클라이언트만 종료 = detach. 세션과 claude는 그대로
        with contextlib.suppress(Exception):
            proc.terminate(force=True)
