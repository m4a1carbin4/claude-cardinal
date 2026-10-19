import argparse
import logging
import os

import uvicorn


def main() -> None:
    p = argparse.ArgumentParser(prog="cardinal-server", description="카디널 서버")
    p.add_argument("--host", help="기본 127.0.0.1 (CARDINAL_HOST)")
    p.add_argument("--port", type=int, help="기본 7878 (CARDINAL_PORT)")
    a = p.parse_args()
    if a.host:
        os.environ["CARDINAL_HOST"] = a.host
    if a.port:
        os.environ["CARDINAL_PORT"] = str(a.port)

    from .app import create_app
    from .config import load

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    s = load()
    uvicorn.run(create_app(s), host=s.host, port=s.port, log_level="info")


if __name__ == "__main__":
    main()
