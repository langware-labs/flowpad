"""FLOWPAD-2112 port guard: a FlowPad activity never kills the FlowPad it runs inside.

The incident: an agentic worker, holding the user's full permissions and running as the
same OS user as the backend, was told by ``flow-diagnose`` to free "port 9007" and ran
``taskkill /PID <pid> /F`` — but the process holding 9007 *is* the backend, so FlowPad
killed itself.

The rule, asked at every kill a FlowPad activity can reach (``flow proc kill``, the
instance sweep, the port-cleanup path): **does the process about to die — or anything in
its tree — listen on one of THIS instance's protected ports?** If so, refuse. That one
question protects:

* the **backend** directly (it is the listener on the server port), and
* its whole ancestor chain — **monitor**, launcher, and the **Electron shell** — because
  the backend is a descendant in their trees, so a tree/name kill that would reach them is
  refused on the backend's behalf.

It deliberately does NOT protect a worker's own children: the backend is their *ancestor*,
not a descendant, so ``listening_under`` of a worker child never contains the server port —
a worker cleaning up its own stuck ``python`` is still allowed.

Design, by construction (not by prompt): no pid registry, no ``create_time`` sidecar, no
files, no feature flag. The protected port is read live from the process table, so a server
that moved or restarted is protected exactly as it runs now. A kill the **user** asked for
(``flow stop``, ``flow instance restart-backend/reset``) passes ``allow_protected=True`` at
the call site — explicit, not global state — and workers are told apart from the human by
``caller_is_worker`` (``FLOWPAD_EXECUTION_SCOPE``).

This is an app-level guard (L0). The real boundary against a worker that bypasses Python
entirely — a raw ``taskkill`` / ``kill`` — is OS containment (a low-integrity / restricted
worker token), tracked as the L1 follow-up.
"""
from __future__ import annotations

import logging
import os
from typing import Iterable

logger = logging.getLogger(__name__)

#: Set by the backend on every worker it spawns (``cli_worker_base_driver.apply_worker_env``)
#: and inherited by anything the worker runs; a human's terminal has none.
_WORKER_ENV = "FLOWPAD_EXECUTION_SCOPE"


class PortGuardRefused(RuntimeError):
    """A kill was refused because its target holds a protected FlowPad port."""

    def __init__(self, pids: Iterable[int], ports: Iterable[int]) -> None:
        self.pids = sorted({int(p) for p in pids})
        self.ports = sorted({int(p) for p in ports})
        super().__init__(
            f"refusing to kill {self.pids}: holds FlowPad's protected port(s) {self.ports} — "
            "this would stop the FlowPad backend this process runs inside"
        )


def protected_ports() -> set[int]:
    """THIS instance's ports that must stay alive — today, the backend server port.

    Read from the running server's own record (``server.json``'s ``port``) and the instance's
    configured port, so a server on a non-default port (any instance that is not ``prod``) is
    covered without hardcoding ``9007``. An empty set (neither readable) means the guard spares
    nothing and every caller falls through to its own behaviour — fail *open* only when there is
    demonstrably no FlowPad to protect.
    """
    ports: set[int] = set()
    try:
        from flow_sdk.config import load_server_info  # noqa: PLC0415

        recorded = load_server_info().get("port")
        if isinstance(recorded, int):
            ports.add(recorded)
    except Exception:  # noqa: BLE001 -- no server.json yet is normal
        pass
    try:
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        ports.add(int(get_instance_settings().port))
    except Exception:  # noqa: BLE001 -- settings not resolvable here
        pass
    return {p for p in ports if p}


def listener_pids(ports: set[int] | None = None) -> set[int]:
    """Pids that listen on a protected port, from one read of the socket table."""
    ports = protected_ports() if ports is None else ports
    if not ports:
        return set()
    from flow_sdk.core import app_ports  # noqa: PLC0415

    return {one.pid for one in app_ports.listeners() if one.port in ports}


def _tree_pids(pid: int) -> set[int]:
    """``pid`` and every live descendant, as a set of pids; empty when the pid is gone."""
    import psutil  # noqa: PLC0415

    try:
        root = psutil.Process(int(pid))
        return {root.pid, *(child.pid for child in root.children(recursive=True))}
    except (psutil.Error, OSError, ValueError):
        return set()


def protected(pids: Iterable[int]) -> set[int]:
    """The subset of *pids* that must not be killed: a pid whose tree (itself or any
    descendant) holds a protected FlowPad port. Empty when no protected port can be read or
    nothing listens on one — the common case on a machine with no FlowPad running, so the
    guard costs one socket-table read and returns.
    """
    wanted = {int(p) for p in pids}
    if not wanted:
        return set()
    holders = listener_pids()
    if not holders:
        return set()
    refused: set[int] = set()
    for pid in wanted:
        if _tree_pids(pid) & holders:
            refused.add(pid)
    return refused


def partition(pids: Iterable[int]) -> tuple[list[int], list[int]]:
    """``(allowed, refused)`` over *pids*, de-duplicated and order-preserving. ``refused`` are
    the protected FlowPad pids; ``allowed`` is everything else and is safe to kill."""
    ordered = list(dict.fromkeys(int(p) for p in pids))
    refused = protected(ordered)
    return [p for p in ordered if p not in refused], [p for p in ordered if p in refused]


def caller_is_worker() -> bool:
    """A FlowPad agentic worker is running this code.

    The backend stamps ``FLOWPAD_EXECUTION_SCOPE`` onto every worker it spawns, and any ``flow``
    CLI the worker runs inherits it; a human running ``flow stop`` in their own shell has none.
    This is an app-level discriminator, not a security boundary — a determined worker can unset
    the variable, which is exactly why the real boundary for a raw OS kill is OS containment
    (L1). Here it only tells a human/monitor lifecycle action (no scope) from a worker's.
    """
    return bool(os.environ.get(_WORKER_ENV, "").strip())


__all__ = [
    "PortGuardRefused",
    "caller_is_worker",
    "listener_pids",
    "partition",
    "protected",
    "protected_ports",
]
