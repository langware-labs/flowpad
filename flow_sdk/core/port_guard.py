"""FLOWPAD-2112 port guard: a FlowPad activity never kills the FlowPad it runs inside.

The incident: an agentic worker, holding the user's full permissions and running as the
same OS user as the backend, was told by ``flow-diagnose`` to free "port 9007" and ran
``taskkill /PID <pid> /F`` — but the process holding 9007 *is* the backend, so FlowPad
killed itself.

The rule, asked at every kill a FlowPad activity can reach (``flow proc kill``, the
instance sweep, the port-cleanup path): **is the process about to die the live backend of
this instance — or an ancestor that has the live backend somewhere beneath it?** If so,
refuse.

Identity is the backend the *backend itself recorded* in ``server.json`` (``server_pid`` +
``server_create_time``), confirmed to still be that live process — NOT "whoever holds the
port". That distinction matters: when the backend has died and a stale ``python`` (or a
foreign program) is left holding 9007, it must be *killable* ("may clean up a stale port
holder"), and keying on the port would wrongly protect it and leave FlowPad unable to
start. ``server.json`` is the backend's own self-record, written at startup
(``server/app.py``), not a registry we maintain on the side.

That single question protects:

* the **backend** directly — it is the recorded live process; and
* its whole **ancestor chain** — monitor, launcher, and the Electron shell — because the
  backend sits beneath them, so a tree- or name-based kill that would reach them is refused
  on the backend's behalf.

It deliberately does **not** protect the backend's *descendants* (workers, their shells,
MCP servers, web apps): the backend is their *ancestor*, so a worker reaping its own stuck
``python`` — or a tree it itself spawned — stays allowed ("may clean up"). Refusal is
decided per *root*: a root whose subtree holds the live backend is spared whole; a root at
or below the backend is not.

No pid registry, no feature flag. The backend's identity is read live each time, so a
backend that moved or restarted is protected exactly as it runs now. With no live recorded
backend, the guard protects nothing (fail open — there is no FlowPad to protect).

This is an app-level guard (L0). The real boundary against a worker that bypasses Python
entirely — a raw ``taskkill`` / ``kill`` — is OS containment (a low-integrity / restricted
worker token), tracked as the L1 follow-up.
"""
from __future__ import annotations

import logging
from typing import Iterable

logger = logging.getLogger(__name__)

#: Tolerance (seconds) when matching a recorded ``create_time`` against the live process, to
#: absorb float rounding between the writer (``server/app.py``) and a reader.
_CREATE_TIME_SLACK = 1.0


class PortGuardRefused(RuntimeError):
    """A kill was refused because its target is (or contains) the live FlowPad backend."""

    def __init__(self, pids: Iterable[int]) -> None:
        self.pids = sorted({int(p) for p in pids})
        super().__init__(
            f"refusing to kill {self.pids}: this is (or contains) the live FlowPad backend "
            "of the instance this process runs inside"
        )


def live_backend_pid() -> int | None:
    """The pid of THIS instance's live backend, from its own ``server.json`` record, confirmed
    to still be that process (``server_create_time`` matches) — else None.

    None covers every "nothing to protect" case: no ``server.json``, no recorded pid, the pid
    is dead, or the pid was reused by a different process. In particular a stale/foreign holder
    of the port is NOT the recorded live backend, so it stays killable.
    """
    try:
        from flow_sdk.config import load_server_info  # noqa: PLC0415

        info = load_server_info() or {}
    except Exception:  # noqa: BLE001 -- no server.json yet is normal
        return None
    pid = info.get("server_pid")
    if not isinstance(pid, int):
        return None
    import psutil  # noqa: PLC0415

    try:
        proc = psutil.Process(pid)
        recorded = info.get("server_create_time")
        if isinstance(recorded, (int, float)) and abs(proc.create_time() - recorded) > _CREATE_TIME_SLACK:
            return None  # pid reused by a different process
        if not proc.is_running():
            return None
    except (psutil.Error, OSError):
        return None
    return pid


def _tree_pids(pid: int) -> set[int]:
    """``pid`` and every live descendant, as a set of pids; empty when the pid is gone."""
    import psutil  # noqa: PLC0415

    try:
        root = psutil.Process(int(pid))
        return {root.pid, *(child.pid for child in root.children(recursive=True))}
    except (psutil.Error, OSError, ValueError):
        return set()


def protected(pids: Iterable[int]) -> set[int]:
    """The subset of *pids* (treated as kill *roots*) that must not be killed: a root whose
    subtree holds the live backend (the backend itself, or an ancestor above it). Empty when
    there is no live recorded backend. One ``server.json`` read plus one tree walk per root —
    the roots are few (the processes a caller actually aimed at), never every listener.
    """
    roots = {int(p) for p in pids}
    if not roots:
        return set()
    backend = live_backend_pid()
    if backend is None:
        return set()
    refused: set[int] = set()
    for root in roots:
        if root == backend or backend in _tree_pids(root):
            refused.add(root)
    return refused


def partition(pids: Iterable[int]) -> tuple[list[int], list[int]]:
    """``(allowed, refused)`` over *pids*, de-duplicated and order-preserving. ``refused`` are
    the protected FlowPad pids; ``allowed`` is everything else and is safe to kill."""
    ordered = list(dict.fromkeys(int(p) for p in pids))
    refused = protected(ordered)
    return [p for p in ordered if p not in refused], [p for p in ordered if p in refused]


__all__ = [
    "PortGuardRefused",
    "live_backend_pid",
    "partition",
    "protected",
]
