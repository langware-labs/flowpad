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
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Callable, Iterable, Literal, Optional

from flow_sdk.core.dev_server import LOOPBACKS, port_open

#: Programs that hold a port FOR something else (a container's published port, a tunnel). Who is
#: behind such a port cannot be read from the process table, so it is judged like a holder that
#: cannot be named: by the app's own health path. Compared by stem, whatever the case or ``.exe``.
_FORWARDERS = frozenset({
    "com.docker.backend", "docker-proxy", "vpnkit", "vpnkit-bridge",  # Docker Desktop / Engine
    "gvproxy", "rootlessport", "pasta", "slirp4netns", "podman",  # Podman, rootless containers
    "limactl", "hostagent", "colima",  # Lima / Colima / Rancher Desktop
    "orbstack", "orbstack helper",  # OrbStack
    "wslrelay", "wslhost",  # WSL2 localhost forwarding
    "ssh",  # ``ssh -L``: a tunnel to a server somewhere else
})


def _forwards(name: str) -> bool:
    return name.lower().removesuffix(".exe") in _FORWARDERS


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


def _listening_by_pid() -> Optional[dict[int, list[int]]]:
    """``pid -> its listening ports`` from ONE read of the system's socket table, or None where that
    read is not allowed (macOS without root). Windows and Linux answer it for every process this user
    can see — and asking each process instead re-reads the whole table per process there (2 s for 200
    processes on Windows, measured)."""
    import psutil  # noqa: PLC0415

    try:
        connections = psutil.net_connections(kind="tcp")
    except (psutil.Error, OSError):
        return None
    found: dict[int, set[int]] = {}
    for connection in connections:
        if connection.status == psutil.CONN_LISTEN and connection.laddr and connection.pid:
            found.setdefault(connection.pid, set()).add(connection.laddr.port)
    return {pid: sorted(ports) for pid, ports in found.items()}


def listeners(port: Optional[int] = None) -> list[Listener]:
    """Every listening TCP port of a process this user can read — or, given ``port``, only the processes
    on it (who they are is then read for those alone). A port held by another user's process is absent:
    ``port_open`` still sees it, which is how ``decide`` knows a holder it cannot name."""
    import psutil  # noqa: PLC0415

    by_pid = _listening_by_pid()
    if by_pid is None:  # one read not allowed here (macOS): ask each process
        by_pid = {}
        for process in psutil.process_iter():
            try:
                if ports := _listening(process):
                    by_pid[process.pid] = ports
            except (psutil.Error, OSError):
                continue
    if port is not None:
        by_pid = {pid: [port] for pid, ports in by_pid.items() if port in ports}
    parents = _parents() if by_pid else {}
    found: list[Listener] = []
    for pid, ports in by_pid.items():
        try:
            process = psutil.Process(pid)
            name = process.name()
            if _forwards(name):
                continue
            cwd = process.cwd() or ""
            commands = [" ".join(process.cmdline()), *_ancestor_commands(process, parents)]
        except (psutil.Error, OSError):
            continue
        found.extend(Listener(pid, one, name, cwd, tuple(commands)) for one in ports)
    return found


def _parents() -> dict[int, int]:
    """``pid -> parent pid`` for every process, from ONE read of the process table. Asking each process
    for its parent re-reads the whole table per question on Windows (a look took over 20 s there)."""
    import psutil  # noqa: PLC0415

    try:
        return dict(psutil._ppid_map())  # noqa: SLF001 -- psutil's own one-read map, what ``children()`` uses
    except Exception:  # noqa: BLE001 -- not there on this psutil: ancestors are simply not read
        return {}


def _ancestor_commands(process, parents: dict[int, int]) -> list[str]:
    """The command lines of the nearest ``_ANCESTORS`` ancestors. Walked through ``parents`` and stopped
    at a pid already seen: on Windows the chain ends in a process that is its own parent, and
    ``psutil.Process.parents()`` — which walks the WHOLE chain first — never returns there. A "parent"
    younger than its child is a recycled pid, not an ancestor."""
    import psutil  # noqa: PLC0415

    commands: list[str] = []
    seen = {process.pid}
    try:
        born = process.create_time()
        pid = parents.get(process.pid)
        while pid is not None and pid not in seen and len(commands) < _ANCESTORS:
            seen.add(pid)
            parent = psutil.Process(pid)
            parent_born = parent.create_time()
            if parent_born > born:
                break
            commands.append(" ".join(parent.cmdline()))
            born, pid = parent_born, parents.get(pid)
    except (psutil.Error, OSError):
        pass
    return commands


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


def of_app(
    snapshot: Iterable[Listener], folder: Path, start_cmd: str, siblings: Iterable[str] = (), theirs: Iterable[int] = ()
) -> list[Listener]:
    """The listeners that are THIS process of the app: inside its folder, and not a sibling process of
    the same app (its API beside its page) — a sibling is told apart by its own start command, and a
    port a sibling declares (``theirs``) is the sibling's: two processes may share one command."""
    home = os.path.realpath(folder)
    taken = set(theirs)
    inside = [one for one in snapshot if _inside(one.cwd, home) and one.port not in taken]
    launched = [one for one in inside if launched_by(one, start_cmd)]
    if launched:
        return launched
    # A listener no command of the app launched (an old page, one started by hand) is the app's FIRST
    # process — its page — never a service beside it.
    if next((command for command in siblings if command), start_cmd) != start_cmd:
        return []
    others = [command for command in siblings if command and command != start_cmd]
    return [one for one in inside if not any(launched_by(one, command) for command in others)]


def stranger_on(port: int, folder: Path, snapshot: Optional[Iterable[Listener]] = None) -> Optional[Listener]:
    """A program that listens on ``port`` and is NOT serving from ``folder`` — when nothing of the
    folder's own listens there. None: the port is free, the folder's own, or its holder cannot be named.
    For a caller handed a port and a folder and asked to believe the two belong together."""
    home = os.path.realpath(folder)
    holders = [one for one in (listeners(port) if snapshot is None else snapshot) if one.port == port]
    if any(_inside(one.cwd, home) for one in holders):
        return None
    return holders[0] if holders else None


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


def kill_trees(pids: Iterable[int]) -> None:
    """End each process and everything started under it — its whole process group on POSIX, never this
    process's own — and return once they are gone, so their ports are free. The group is signalled too
    because a member whose leader already died is no longer anyone's child. Each process is also ended
    directly: on Windows there is no group, and ``taskkill /T`` (which asks WMI for the tree) was seen to
    stall for over 30 s. Only what was signalled is waited for — one that could not be ended (another
    user's) would be waited on forever."""
    import psutil  # noqa: PLC0415

    doomed: dict[int, "psutil.Process"] = {}
    groups: set[int] = set()
    for pid in pids:
        doomed.update((member.pid, member) for member in _tree(pid))
        if sys.platform == "win32":
            continue
        try:
            group = os.getpgid(pid)
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
    ended = []
    for process in doomed.values():
        try:
            process.kill()
            ended.append(process)
        except (psutil.Error, OSError):
            continue
    psutil.wait_procs(ended)


def stop(found: Iterable[Listener]) -> None:
    """End each listener and everything started with it (``kill_trees``)."""
    kill_trees(one.pid for one in found)


__all__ = ["Declared", "Listener", "PortAnswer", "decide", "free_port", "kill_trees", "launched_by", "listeners", "listening_under", "of_app", "stop", "stranger_on"]
