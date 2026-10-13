"""Which port an app's process runs on — decided in ONE place, from two facts and nothing saved.

* **Declared** — ``serving.ports.local`` in ``webapp.json`` (``WebappPortSpec``): the port, and whether
  the app can only run there (``required``).
* **Live** — the process table. A listening process is THIS app's when its working folder is inside
  the app's folder. No owner file and no remembered port: a server that died, moved, or was started
  by hand is read as what it is now.

``decide`` is the whole rule and is pure over a snapshot; ``listeners`` takes the snapshot and ``stop``
ends what a snapshot named. Stdlib + ``psutil`` and synchronous, like ``dev_server`` — an async caller
runs these through ``asyncio.to_thread``.
"""

from __future__ import annotations

import os
import re
import signal
import socket
import subprocess
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Callable, Iterable, Literal, Optional

from flow_sdk.core.dev_server import LOOPBACKS, port_open

#: Programs that hold a port FOR something else (a container's published port). Who is behind such a
#: port cannot be read from the process table, so it is judged like a holder that cannot be named.
_FORWARDERS = frozenset({"com.docker.backend", "docker-proxy", "vpnkit", "gvproxy", "limactl", "rootlessport"})
#: How far up a listener's ancestry its launch command is looked for (server ← runtime ← npx ← shell).
_ANCESTORS = 6


@dataclass(frozen=True)
class Declared:
    """An app process's declared port on this environment."""

    port: int
    required: bool = True


@dataclass(frozen=True)
class Listener:
    """One process listening on one port, as the process table shows it now."""

    pid: int
    port: int
    name: str
    cwd: str
    #: Its own command line, then its ancestors' (nearest first) — how it was launched.
    commands: tuple[str, ...] = ()

    def said(self) -> str:
        return f"{self.name or 'a program'} (pid {self.pid})"


@dataclass(frozen=True)
class PortAnswer:
    """What ``decide`` found. ``running``: the app is up on ``port``. ``start``: start it on ``port``.
    ``conflict``: ``port`` is the app's only port and someone else holds it. ``wrong_port``: the app
    itself is up, but not on the port it must have."""

    state: Literal["running", "start", "conflict", "wrong_port"]
    port: int
    holder: Optional[Listener] = None
    note: str = ""


def _listening(process) -> list[int]:
    """The TCP ports ``process`` (a ``psutil.Process``) listens on. Raises ``psutil.Error`` when it cannot be read."""
    import psutil  # noqa: PLC0415 -- leaf module

    return sorted({c.laddr.port for c in process.net_connections(kind="tcp") if c.status == psutil.CONN_LISTEN and c.laddr})


def _tree(pid: int) -> list:
    """``pid`` and everything started under it, as ``psutil.Process``; empty when it is gone."""
    import psutil  # noqa: PLC0415

    try:
        root = psutil.Process(pid)
        return [root, *root.children(recursive=True)]
    except psutil.Error:
        return []


def listening_under(pid: int) -> set[int]:
    """The ports the process started as ``pid``, and everything under it, listens on."""
    import psutil  # noqa: PLC0415

    ports: set[int] = set()
    for member in _tree(pid):
        try:
            ports.update(_listening(member))
        except (psutil.Error, OSError):
            continue
    return ports


def listeners() -> list[Listener]:
    """Every listening TCP port of a process this user can read. A port held by another user's process
    is absent — ``port_open`` still sees it, which is how ``decide`` knows a holder it cannot name."""
    import psutil  # noqa: PLC0415

    found: list[Listener] = []
    for process in psutil.process_iter():
        try:
            ports = _listening(process)
            if not ports:
                continue
            name = process.name()
            if name in _FORWARDERS:
                continue
            cwd = process.cwd() or ""
            commands = [" ".join(process.cmdline())]
            for parent in process.parents()[:_ANCESTORS]:
                try:
                    commands.append(" ".join(parent.cmdline()))
                except psutil.Error:
                    break
        except (psutil.Error, OSError):
            continue
        found.extend(Listener(process.pid, port, name, cwd, tuple(commands)) for port in ports)
    return found


def _inside(cwd: str, folder: str) -> bool:
    """``cwd`` is ``folder`` (already resolved) or inside it."""
    if not cwd:
        return False
    try:
        Path(os.path.realpath(cwd)).relative_to(folder)
    except ValueError:
        return False
    return True


def _unquoted(text: str) -> str:
    """Without the quotes a shell strips: a process's command line is its ARGUMENTS joined, so
    ``"C:\\py\\python.exe" -m x`` is read back as ``C:\\py\\python.exe -m x``."""
    return text.replace('"', "").replace("'", "").strip()


@lru_cache(maxsize=64)
def _launch_pattern(start_cmd: str) -> "re.Pattern[str]":
    return re.compile(r"(?:^|\s)" + r"\d+".join(re.escape(part) for part in _unquoted(start_cmd).split("{port}")) + r"$")


def launched_by(listener: Listener, start_cmd: str) -> bool:
    """The listener, or an ancestor, was started with exactly ``start_cmd`` — whatever port it was given.
    Exactly: the command line ENDS with it (a shell's is ``sh -c <command>``), so a sibling whose command
    merely contains this one is not mistaken for it. Quotes do not count: they are the shell's."""
    if not _unquoted(start_cmd):
        return False
    return any(_launch_pattern(start_cmd).search(_unquoted(line)) for line in listener.commands)


def of_app(snapshot: Iterable[Listener], folder: Path, start_cmd: str, siblings: Iterable[str] = ()) -> list[Listener]:
    """The listeners that are THIS process of the app: inside its folder, and not a sibling process of
    the same app (its API beside its page) — a sibling is told apart by its own start command."""
    home = os.path.realpath(folder)
    inside = [one for one in snapshot if _inside(one.cwd, home)]
    launched = [one for one in inside if launched_by(one, start_cmd)]
    if launched:
        return launched
    others = [command for command in siblings if command and command != start_cmd]
    return [one for one in inside if not any(launched_by(one, command) for command in others)]


def free_port(taken: Iterable[int] = (), candidates: Iterable[int] = ()) -> int:
    """A port nothing listens on at either loopback and nobody declared: the first free ``candidate``,
    else one the OS assigns."""
    reserved = set(taken)
    for port in candidates:
        if port not in reserved and not port_open(port):
            return port
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind((LOOPBACKS[0], 0))
            port = int(sock.getsockname()[1])
        # The OS answered for IPv4 alone: a server on ``::1`` only would share the number.
        if port not in reserved and not port_open(port):
            return port


def decide(
    declared: Optional[Declared],
    mine: list[Listener],
    snapshot: Iterable[Listener],
    *,
    reserved: Iterable[int] = (),
    answers: Callable[[int], bool] = lambda _port: False,
    is_open: Callable[[int], bool] = port_open,
    pick: Optional[Callable[[set[int]], int]] = None,
) -> PortAnswer:
    """The one rule. ``mine``: this app process's listeners (``of_app``). ``reserved``: ports other apps
    declare. ``answers``: the app's own health path answers on a port — asked only for a holder that
    cannot be named (another user's process, a container's published port)."""
    taken = set(reserved)
    pick = pick or free_port
    if declared is None:
        if mine:
            return PortAnswer("running", mine[0].port, mine[0])
        return PortAnswer("start", pick(taken))

    port = declared.port
    on_port = next((one for one in mine if one.port == port), None)
    if on_port is not None:
        return PortAnswer("running", port, on_port)
    if mine and not declared.required:
        return PortAnswer("running", mine[0].port, mine[0])
    if mine:
        return PortAnswer(
            "wrong_port", mine[0].port, mine[0],
            f"is running on port {mine[0].port} ({mine[0].said()}), but it can only run on port {port} — "
            "stop it, or change the port it declares",
        )

    holder = next((one for one in snapshot if one.port == port), None)
    busy = holder is not None or is_open(port)
    if not busy and (port not in taken or declared.required):
        return PortAnswer("start", port)
    if not declared.required:
        moved = pick(taken | {port})
        return PortAnswer("start", moved, holder, f"port {port} is busy, so it runs on port {moved}")
    if holder is None and answers(port):
        return PortAnswer("running", port, None, "started outside Flowpad")
    who = f": {holder.said()}" if holder is not None else ""
    return PortAnswer("conflict", port, holder, f"port {port} is held by another program{who}")


def stop(found: Iterable[Listener]) -> None:
    """End each listener and everything started with it, and return once they are gone — so the port is
    free. The whole process group goes (the shell AND the server under it); never this process's own."""
    import psutil  # noqa: PLC0415

    doomed: dict[int, "psutil.Process"] = {}
    groups: set[int] = set()
    for one in found:
        doomed.update((member.pid, member) for member in _tree(one.pid))
        if sys.platform == "win32":
            continue
        try:
            group = os.getpgid(one.pid)
        except OSError:
            continue
        if group != os.getpgrp():
            groups.add(group)
            doomed.update((member.pid, member) for member in _tree(group))
    for group in groups:
        try:
            os.killpg(group, signal.SIGKILL)
        except OSError:
            pass
    for pid, process in doomed.items():
        try:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, check=False)  # noqa: S603, S607
            else:
                process.kill()
        except (psutil.Error, OSError):
            pass
    psutil.wait_procs(list(doomed.values()))


__all__ = ["Declared", "Listener", "PortAnswer", "decide", "free_port", "launched_by", "listeners", "listening_under", "of_app", "stop"]
