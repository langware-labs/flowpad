"""Local dev servers: pick a port, probe it, start a server detached, wait for it.

One home for what ``flow app open`` (the CLI) and a placement exposing a
webapp's endpoints (``webapp_placement``) both do. Stdlib only and synchronous —
an async caller runs these through ``asyncio.to_thread``.
"""

from __future__ import annotations

import os
import re
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Optional


def log_dir() -> Path:
    """Where a started server's output goes (``<slug>-<port>.log``): this instance's logs."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415 -- leaf module

    return get_instance_settings().logs_dir / "app-open"


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


#: Both loopbacks. A Node server told ``localhost`` binds ``::1`` alone on a modern Node (it resolves the
#: name verbatim), a Python one ``127.0.0.1`` alone: a probe that asks one address calls the other "never
#: opened" while the server's own log says ready.
#: What a launched server is told to bind: this machine only.
LOOPBACK_HOST = "127.0.0.1"
LOOPBACKS = (LOOPBACK_HOST, "::1")


def loopback_urls(port: int, path: str = "/") -> list[str]:
    """``path`` on ``port`` at each loopback, IPv6 bracketed — what a health probe asks, in order."""
    rel = path if path.startswith("/") else "/" + path
    return [f"http://{'[' + host + ']' if ':' in host else host}:{int(port)}{rel}" for host in LOOPBACKS]


def port_open(port: int) -> bool:
    for host in LOOPBACKS:
        try:
            with socket.create_connection((host, int(port)), timeout=0.5):
                return True
        except OSError:
            continue
    return False


def wait_for_port(port: int, timeout: float, *, exited: Optional[Callable[[], bool]] = None) -> bool:
    """The port opened within ``timeout``. ``exited`` ends the wait early: a server that already died
    will never open it, and waiting out the budget only hides the crash."""
    deadline = time.monotonic() + max(timeout, 0)
    while time.monotonic() <= deadline:
        if port_open(port):
            return True
        if exited is not None and exited():
            return False
        time.sleep(0.25)
    return port_open(port)


def _slug(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", name).strip("-") or "webapp"


def start_process(command: str, *, cwd: Path, port: int, name: str) -> tuple[subprocess.Popen, str]:
    """Start *command* in its own session, logging to ``log_dir()``. Returns ``(process, log_file)``.

    ``PORT`` is set as well as whatever the command line says: a server that
    reads its port from the environment needs no ``{port}`` in its command.
    ``HOST`` is set to loopback as a HINT (Next honours it; Vite and uvicorn take
    a flag, which the templates pass): the process is reached only through this
    machine's own door (``server/audience_listener.py``), which is what admits a
    browser to it. A server that binds every interface on a box whose ports are
    public has no door at all; an author who binds it so in the command owns that.
    """
    logs = log_dir()
    logs.mkdir(parents=True, exist_ok=True)
    log_file = logs / f"{_slug(name)}-{port}.log"
    log = log_file.open("ab")
    proc = subprocess.Popen(  # noqa: S602 -- the command is the app author's own start command
        command,
        cwd=str(cwd),
        shell=True,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        env={**os.environ, "PORT": str(port), "HOST": LOOPBACK_HOST},
    )
    log.close()
    return proc, str(log_file)


def start_detached(command: str, *, cwd: Path, port: int, name: str) -> tuple[int | None, str]:
    """``start_process`` for a caller that only names the pid."""
    proc, log_file = start_process(command, cwd=cwd, port=port, name=name)
    return proc.pid, log_file


def log_tail(log_file: str, lines: int = 8) -> str:
    """The log's last lines. A dev server's log is appended to across every start and never rotated:
    only its end is read."""
    try:
        with open(log_file, "rb") as log:
            log.seek(0, os.SEEK_END)
            log.seek(max(log.tell() - 65536, 0))
            return "\n".join(log.read().decode(errors="replace").splitlines()[-lines:])
    except OSError:
        return ""


def stop_group(pid: int) -> None:
    """Kill the session ``start_process`` made (the shell AND the server under it) and wait until it is
    gone, so its port is free when this returns. Killing only the shell leaves the server holding the port."""
    import psutil  # noqa: PLC0415 -- leaf module

    try:
        shell = psutil.Process(pid)
        group = [shell, *shell.children(recursive=True)]
    except psutil.Error:
        group = []
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, check=False)  # noqa: S603, S607
        else:
            os.killpg(pid, signal.SIGKILL)
    except OSError:
        pass
    psutil.wait_procs(group)


# ── which process is OURS ─────────────────────────────────────────────────────────────────────────────
# A port answering is not proof the app answers. What a start launched is recorded beside its log
# (pid + the process's own start time, so a recycled pid is never mistaken for it); "running" asks it.


def owner_dir() -> Path:
    """Where what was started is recorded. Beside the logs, not in them: clearing logs must not turn a
    server we started into a stranger's."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415 -- leaf module

    return get_instance_settings().logs_dir.parent / "app-open"


def _owner_file(key: str) -> Path:
    return owner_dir() / f"{_slug(key)}.json"


def record_owner(key: str, pid: int, port: int) -> None:
    import psutil  # noqa: PLC0415

    from flow_sdk.instances.atomic import write_json_atomic  # noqa: PLC0415

    try:
        created = psutil.Process(pid).create_time()
    except psutil.Error:
        return
    target = _owner_file(key)
    target.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(target, {"pid": pid, "port": int(port), "created": created})


def owner(key: str) -> Optional[dict]:
    """What the last start of ``key`` launched, or None when Flowpad never started it (a server the
    person runs themselves)."""
    from flow_sdk.instances.atomic import read_json  # noqa: PLC0415

    record = read_json(_owner_file(key))
    return record if "pid" in record else None


def owner_alive(record: dict) -> bool:
    import psutil  # noqa: PLC0415

    try:
        process = psutil.Process(int(record["pid"]))
        return process.create_time() == record.get("created") and process.status() != psutil.STATUS_ZOMBIE
    except (psutil.Error, ValueError, TypeError):
        return False


def clear_owner(key: str) -> None:
    _owner_file(key).unlink(missing_ok=True)


def install_command(start_cmd: str, folder: Path) -> str:
    """What installs an app's dependencies when it does not say: its package manager's own install
    (read off how it starts), ``npm ci`` with a lockfile, else ``npm install``."""
    for manager in ("pnpm", "yarn", "bun"):
        if start_cmd.startswith(f"{manager} "):
            return f"{manager} install"
    return "npm ci" if (folder / "package-lock.json").exists() else "npm install"


__all__ = [
    "LOOPBACK_HOST",
    "LOOPBACKS",
    "clear_owner",
    "find_free_port",
    "install_command",
    "log_dir",
    "log_tail",
    "loopback_urls",
    "owner",
    "owner_alive",
    "owner_dir",
    "port_open",
    "record_owner",
    "start_detached",
    "start_process",
    "stop_group",
    "wait_for_port",
]
