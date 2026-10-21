"""Local dev servers: probe a port, start a server detached, wait for it.

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
from typing import Callable, Optional


def log_dir() -> Path:
    """Where a started server's output goes (``<slug>-<port>.log``): this instance's logs."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415 -- leaf module

    return get_instance_settings().logs_dir / "app-open"


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


def loopback_status(url: str, timeout: float) -> Optional[int]:
    """The HTTP status ``url`` — an address on THIS machine — answers with, or None when nothing does.

    Asked directly, never through the system's proxy: ``urllib``'s default opener reads the proxy
    settings and, on Windows, resolves the host by name to decide whether to bypass them — seconds to
    tens of seconds per probe on a box with slow name lookup, for an address that is always local."""
    import urllib.error  # noqa: PLC0415
    import urllib.request  # noqa: PLC0415

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=timeout) as response:  # noqa: S310 -- loopback only
            return int(response.status)
    except urllib.error.HTTPError as error:
        return int(error.code)
    except (urllib.error.URLError, OSError, ValueError):
        return None


def loopback_answers(port: int, path: str = "/", *, timeout: float, healthy=lambda status: True) -> bool:
    """Something answers HTTP at ``path`` on ``port`` on either loopback, and ``healthy(status)`` holds.
    A port the socket table lists as closed is not asked (see ``port_open``)."""
    if _listed(int(port)) is False:
        return False
    for url in loopback_urls(port, path):
        status = loopback_status(url, timeout)
        if status is not None:
            return healthy(status)
    return False


#: A listener on any of these takes connections to a loopback.
_LOCAL_BINDS = {*LOOPBACKS, "0.0.0.0", "::"}


def _listed(port: int) -> Optional[bool]:
    """Whether the system's socket table lists a listener on ``port`` at a loopback or every address;
    None where this user cannot read the whole table (macOS)."""
    import psutil  # noqa: PLC0415

    try:
        table = psutil.net_connections(kind="tcp")
    except (psutil.Error, OSError):
        return None
    return any(
        one.status == psutil.CONN_LISTEN and one.laddr and one.laddr.port == port and one.laddr.ip in _LOCAL_BINDS
        for one in table
    )


def port_open(port: int) -> bool:
    """Something listens on ``port`` at a loopback. The socket table is asked first: on Windows a connect
    to a closed port is not refused but retried until its timeout, and one such connect was seen never to
    return at all. Where the table cannot be read, a connect is the probe (refused at once there)."""
    port = int(port)
    if (listed := _listed(port)) is not None:
        return listed
    for host in LOOPBACKS:
        try:
            with socket.create_connection((host, port), timeout=0.5):
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


def start_process(
    command: str, *, cwd: Path, port: int, name: str, env: Optional[dict[str, str]] = None
) -> tuple[subprocess.Popen, str]:
    """Start *command* in its own session, logging to ``log_dir()``. Returns ``(process, log_file)``.

    ``PORT`` is set as well as whatever the command line says: a server that
    reads its port from the environment needs no ``{port}`` in its command.
    ``env`` adds to it: the ports of the app's other processes (``FLOWPAD_APP_PORT_<NAME>``).
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
        env={**os.environ, **(env or {}), "PORT": str(port), "HOST": LOOPBACK_HOST},
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
    from flow_sdk.core.app_ports import kill_trees  # noqa: PLC0415 -- app_ports imports this module

    kill_trees([pid])


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
    "install_command",
    "log_dir",
    "log_tail",
    "loopback_answers",
    "loopback_status",
    "loopback_urls",
    "port_open",
    "start_detached",
    "start_process",
    "stop_group",
    "wait_for_port",
]
