"""``flow proc ...`` — the broker for legitimate process kills (FLOWPAD-2112).

A kill requested from inside FlowPad must never take down a live FlowPad process,
but must still be able to clean up — a user's stuck ``python``, a stale server, an
unrelated process. This broker resolves the targets, subtracts anything that holds
a protected FlowPad port (``port_guard.partition``), and kills only the rest. A
name-based request ("kill python") is matched exactly against the image name and
resolved to PIDs here, so the backend — which shares the ``python`` image — is
spared by the port it holds, not mistaken for a stranger.

The port guard is applied ALWAYS here, with no bypass: ``flow proc kill`` exists
to free the user's own stuck processes, never to stop FlowPad, so it has no
``allow_protected`` escape — a user who means to stop FlowPad runs ``flow stop``.

One JSON line on stdout:
``{"killed": [...], "refused_protected": [...], "denied": [...], "not_found": [...]}``.
"""
from __future__ import annotations

import json
import os
import re
from typing import Optional

import typer
from typing_extensions import Annotated

proc_app = typer.Typer(help="Broker for process kills that never kill FlowPad itself.")

#: Trailing version suffix on an image name — ``python3.11`` / ``python3`` → ``python``.
_VERSION_SUFFIX = re.compile(r"[0-9][0-9.]*$")


def _image_base(name: str) -> str:
    """An image name, lowercased, without ``.exe`` and without a trailing version suffix, so
    ``python`` matches the real process names ``python3`` / ``python3.11`` / ``Python`` that
    macOS and Linux actually report."""
    return _VERSION_SUFFIX.sub("", name.lower().removesuffix(".exe"))


def _self_and_ancestors() -> set[int]:
    """This process and its whole ancestor chain. A worker's ``flow proc kill`` runs
    under the backend (worker ← backend ← monitor ← launcher ← Electron), so excluding
    the ancestors keeps a ``--name python`` request from ever resolving to the backend
    or launcher that spawned it — the port guard then still spares them by identity."""
    import psutil  # noqa: PLC0415

    pids = {os.getpid()}
    try:
        pids.update(parent.pid for parent in psutil.Process(os.getpid()).parents())
    except psutil.Error:
        pass
    return pids


def _pids_for_name(name: str) -> list[int]:
    """PIDs whose image name matches ``name`` by base name — version suffixes aside, so ``python``
    matches ``python3`` / ``python3.11`` but still not a substring like ``python-lsp``. The caller's
    own ancestor chain is excluded so a worker's ``--name python`` never resolves to the backend or
    launcher that spawned it (the port guard then still spares them by identity)."""
    import psutil  # noqa: PLC0415

    exclude = _self_and_ancestors()
    wanted = _image_base(name)
    out: list[int] = []
    for proc in psutil.process_iter(["pid", "name"]):
        try:
            if proc.pid in exclude:
                continue
            if _image_base(proc.info["name"] or "") == wanted:
                out.append(proc.pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return out


@proc_app.command("kill")
def kill(
    pids: Annotated[Optional[list[int]], typer.Argument(help="PIDs to kill.")] = None,
    name: Annotated[Optional[str], typer.Option("--name", help="Kill processes whose image name matches EXACTLY (e.g. python).")] = None,
) -> None:
    """Kill the given PIDs / name matches, always sparing any process that holds a protected FlowPad port."""
    import psutil  # noqa: PLC0415

    from flow_sdk.core import app_ports, port_guard  # noqa: PLC0415

    targets: list[int] = list(pids or [])
    if name:
        targets += _pids_for_name(name)
    targets = list(dict.fromkeys(targets))

    if not targets:
        # Nothing matched — say so on stderr and exit non-zero, so a caller (or the
        # flow-diagnose skill) does not read empty lists as "the kill succeeded".
        typer.echo("flow proc kill: no processes selected (no PIDs given / no name match)", err=True)
        typer.echo(json.dumps({"killed": [], "refused_protected": [], "denied": [], "not_found": []}))
        raise typer.Exit(1)

    allowed, refused = port_guard.partition(targets)

    killed: list[int] = []
    denied: list[int] = []
    not_found: list[int] = []
    for pid in allowed:
        if not app_ports.pid_alive(pid):
            not_found.append(pid)
            continue
        try:
            psutil.Process(pid).kill()
            killed.append(pid)
        except psutil.NoSuchProcess:
            not_found.append(pid)
        except psutil.AccessDenied:
            denied.append(pid)  # not ours to signal — distinct from "gone"

    typer.echo(json.dumps({
        "killed": sorted(killed),
        "refused_protected": sorted(refused),
        "denied": sorted(denied),
        "not_found": sorted(not_found),
    }))
