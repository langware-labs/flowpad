"""Local dev servers: pick a port, probe it, start a server detached, wait for it.

One home for what ``flow app open`` (the CLI) and a placement exposing a
webapp's endpoints (``webapp_placement``) both do. Stdlib only and synchronous —
an async caller runs these through ``asyncio.to_thread``.
"""

from __future__ import annotations

import os
import re
import socket
import subprocess
import time
from pathlib import Path

#: Where a started server's output goes: ``<slug>-<port>.log``.
LOG_DIR = Path.home() / ".flow" / "app-open-logs"


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.5):
            return True
    except OSError:
        return False


def wait_for_port(port: int, timeout: float) -> bool:
    deadline = time.monotonic() + max(timeout, 0)
    while time.monotonic() <= deadline:
        if port_open(port):
            return True
        time.sleep(0.25)
    return port_open(port)


def start_detached(command: str, *, cwd: Path, port: int, name: str) -> tuple[int | None, str]:
    """Start *command* in its own session, logging to ``LOG_DIR``. Returns ``(pid, log_file)``.

    ``PORT`` is set as well as whatever the command line says: a server that
    reads its port from the environment needs no ``{port}`` in its command.
    """
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^a-zA-Z0-9_.-]+", "-", name).strip("-") or "webapp"
    log_file = LOG_DIR / f"{slug}-{port}.log"
    log = log_file.open("ab")
    proc = subprocess.Popen(  # noqa: S602 -- the command is the app author's own start command
        command,
        cwd=str(cwd),
        shell=True,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        env={**os.environ, "PORT": str(port)},
    )
    log.close()
    return proc.pid, str(log_file)


__all__ = ["LOG_DIR", "find_free_port", "port_open", "start_detached", "wait_for_port"]
