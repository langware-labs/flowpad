"""``flow proc ...`` — the broker for legitimate process kills (FLOWPAD-2112).

A kill requested from inside FlowPad must never take down a live FlowPad process,
but must still be able to clean up — a user's stuck ``python``, a stale server, an
unrelated process. This broker resolves the targets and subtracts every live FlowPad
process the caller must not touch, identified by ``server.json`` ancestry — NOT by
"who holds a port":

* this instance's live backend and its ancestors (``port_guard.partition``); and
* every OTHER live FlowPad process — other instances' backends/monitors, sibling
  workers, and the MCP servers those spawned (``port_guard.foreign_flowpad_pids``) —

minus the caller's OWN subtree, which it may clean up. So a worker's ``--name python``
frees its own stuck ``python`` but never a sibling's, another instance's backend, or
its own monitor; the backend, sharing the ``python`` image, is spared by identity.

The guard is applied ALWAYS here, with no bypass: ``flow proc kill`` exists to free
the user's own stuck processes, never to stop FlowPad, so it has no ``allow_protected``
escape — a user who means to stop FlowPad runs ``flow stop``.

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

#: Only these interpreters ship version-suffixed binaries we want ``--name <x>`` to unify.
#: The suffix is stripped ONLY when the result is one of these — so ``python3.11`` → ``python``
#: but ``x264`` stays ``x264`` (not ``x``) and a random ``foo2`` keeps its digits.
_VERSIONED_INTERPRETERS = frozenset({"python", "node"})


def _image_base(name: str) -> str:
    """An image name, lowercased and without ``.exe``; a trailing version suffix is dropped only
    when doing so yields a known versioned interpreter, so ``python`` matches the real process
    names ``python3`` / ``python3.11`` / ``Python`` that macOS and Linux report, while unrelated
    names that merely end in digits (``x264``, ``node-sass``, ``foo2``) are left intact."""
    base = name.lower().removesuffix(".exe")
    stripped = _VERSION_SUFFIX.sub("", base)
    return stripped if stripped != base and stripped in _VERSIONED_INTERPRETERS else base


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
    name: Annotated[Optional[str], typer.Option("--name", help="Kill processes by image base name, version suffix aside (e.g. python matches python3 / python3.11, but not python-lsp).")] = None,
) -> None:
    """Kill the given PIDs / name matches, always sparing any live FlowPad process (by server.json identity, not by port) that is not the caller's own to clean up."""
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

    # Spare EVERY live FlowPad process that is not the caller's own to clean up: this instance's
    # backend AND other instances' backends/monitors, sibling workers, and the MCP servers they
    # spawned. `partition` alone only knows this instance's backend, so an unqualified `--name
    # python` would otherwise sweep the rest — against the invariant. The caller's own subtree
    # (its stuck python, a tree it spawned) stays killable; `foreign_flowpad_pids` excludes it.
    foreign = port_guard.foreign_flowpad_pids()
    allowed_targets = [t for t in targets if t not in foreign]
    allowed, refused_here = port_guard.partition(allowed_targets)
    refused = sorted(set(refused_here) | (set(targets) & foreign))

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
