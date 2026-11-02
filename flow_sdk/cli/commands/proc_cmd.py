"""``flow proc ...`` — the broker for legitimate process kills (FLOWPAD-2112).

A kill requested from inside FlowPad must never take down a live FlowPad process,
but must still be able to clean up — a user's stuck ``python``, a stale server, an
unrelated process. This broker runs OUTSIDE any worker sandbox, resolves the
targets, subtracts the protected-set (``self_protection.partition_kill``), and
kills only the rest. A name-based request ("kill python") is resolved to PIDs
here, so the backend — which shares the ``python`` image — is spared by identity,
not by name.

One JSON line on stdout: ``{"killed": [...], "refused_protected": [...], "not_found": [...]}``.
"""
from __future__ import annotations

import json
import os
import signal
from typing import Optional

import typer
from typing_extensions import Annotated

proc_app = typer.Typer(help="Broker for process kills that never kill FlowPad itself.")


def _pids_for_name(name: str) -> list[int]:
    import psutil  # noqa: PLC0415

    self_pid = os.getpid()
    out: list[int] = []
    for p in psutil.process_iter(["pid", "name"]):
        try:
            if p.pid != self_pid and name.lower() in (p.info["name"] or "").lower():
                out.append(p.pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return out


def _alive(pid: int) -> bool:
    import psutil  # noqa: PLC0415

    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except (psutil.NoSuchProcess, psutil.AccessDenied, ValueError):
        return False


@proc_app.command("kill")
def kill(
    pids: Annotated[Optional[list[int]], typer.Argument(help="PIDs to kill.")] = None,
    name: Annotated[Optional[str], typer.Option("--name", help="Kill processes whose image name matches (e.g. python).")] = None,
) -> None:
    """Kill the given PIDs / name matches, sparing any live protected FlowPad process."""
    from flow_sdk.core import self_protection  # noqa: PLC0415

    targets: list[int] = list(pids or [])
    if name:
        targets += _pids_for_name(name)
    targets = list(dict.fromkeys(targets))

    allowed, refused = self_protection.partition_kill(targets)

    killed, not_found = [], []
    for pid in allowed:
        if not _alive(pid):
            not_found.append(pid)
            continue
        try:
            os.kill(pid, signal.SIGKILL)
            killed.append(pid)
        except ProcessLookupError:
            not_found.append(pid)
        except PermissionError:
            not_found.append(pid)  # not ours to signal

    typer.echo(json.dumps({
        "killed": sorted(killed),
        "refused_protected": sorted(refused),
        "not_found": sorted(not_found),
    }))
