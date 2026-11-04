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
* its live **ancestor chain** — whatever genuinely sits above the backend in the process tree
  right now, so a tree- or name-based kill that would reach an ancestor is refused on the
  backend's behalf. In practice that is the **monitor** (the backend's parent).

It does NOT reliably protect the **launcher** or the **Electron shell**. The backend is spawned
*detached* (``start_detached_process`` / a new session), so whoever launched it — ``flow start``,
or the desktop Electron process — is typically no longer an ancestor once the backend is live (the
monitor reparents to ``init``/``launchd``). Nothing records their pids either, so there is no
identity to key on. Killing the Electron GUI is also outside the incident class this guard targets
(a port-cleanup / "kill python" that takes down the headless backend). Containing a worker that
targets the launcher or the GUI directly is an L1 (OS-containment) concern.

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


def _confirm_recorded_backend(info: dict) -> int | None:
    """The ``server_pid`` in a ``server.json`` dict, confirmed to still be that live process
    (``server_create_time`` matches) — else None. Pure over the dict; no I/O."""
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
    return _confirm_recorded_backend(info)


def live_backend_pids() -> set[int]:
    """The live backend pid of EVERY instance on this host — each instance's own ``server.json``
    record, confirmed live. Empty when none is running.

    ``live_backend_pid`` answers only for the instance this process targets; ``flow proc kill``
    needs them all, because an unqualified name match (``--name python``) can otherwise resolve to
    *another* instance's backend, which is just as much a live FlowPad process as this one's.
    """
    import json  # noqa: PLC0415

    pids: set[int] = set()
    try:
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        instances_root = get_instance_settings().server_json_path.parent.parent
    except Exception:  # noqa: BLE001
        return pids
    try:
        candidates = list(instances_root.glob("*/server.json"))
    except OSError:
        return pids
    for path in candidates:
        try:
            info = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        pid = _confirm_recorded_backend(info) if isinstance(info, dict) else None
        if pid is not None:
            pids.add(pid)
    return pids


def foreign_flowpad_pids() -> set[int]:
    """Every live FlowPad process the CALLER must not kill: each instance's live backend, the
    ancestors above it (the monitor) and all of its descendants (sibling workers, their shells and
    MCP servers) — MINUS the caller's OWN subtree, which it may clean up.

    This is the invariant for ``flow proc kill``: "may clean up a worker's own child" (so the
    caller's own stuck ``python`` or a tree it spawned stays killable) but "must not disrupt another
    FlowPad activity" (a sibling worker, an MCP server a sibling spawned, or another instance's
    backend/monitor — all live FlowPad, none of them the caller's own). Empty when no backend is
    live anywhere (nothing to protect — a stale/foreign port holder is not under any live backend).
    """
    import os  # noqa: PLC0415

    import psutil  # noqa: PLC0415

    backends = live_backend_pids()
    if not backends:
        return set()
    flow: set[int] = set()
    for bpid in backends:
        flow.add(bpid)
        try:
            proc = psutil.Process(bpid)
            flow.update(child.pid for child in proc.children(recursive=True))
            flow.update(anc.pid for anc in proc.parents())
        except (psutil.Error, OSError):
            continue
    me = os.getpid()
    own = {me}
    try:
        own.update(child.pid for child in psutil.Process(me).children(recursive=True))
    except (psutil.Error, OSError):
        pass
    return flow - own


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


def caller_is_worker() -> bool:
    """Whether this process is (or runs under) a FlowPad worker.

    Keyed on ``FLOWPAD_WORKER`` (:data:`flow_sdk.utils.environment.WORKER_ENV`), which the backend
    stamps at the single worker-spawn chokepoint (``apply_worker_env``) and a worker's children
    inherit. Deliberately NOT ``FLOWPAD_EXECUTION_SCOPE``: that is set in the FlowPad desktop
    terminal as well, so it cannot tell a human apart from a worker. This lets the lifecycle gate
    (``flow stop`` / ``flow instance reset`` of the caller's OWN instance) refuse a worker without
    blocking a human in the desktop terminal or a worker managing a DIFFERENT instance.
    """
    from flow_sdk.utils.environment import is_worker_process  # noqa: PLC0415

    return is_worker_process()


def runs_under(pid: int | None) -> bool:
    """Whether THIS process IS *pid* or a descendant of it — i.e. *pid* is a backend this process
    runs inside, so stopping it would take down our own FlowPad.

    Read from the live process tree, NOT from ``FLOW_INSTANCE`` or ``live_backend_pid()`` (both of
    which follow a ``FLOW_INSTANCE=<other> flow stop`` override and would wrongly flag a different
    instance). This is what lets the lifecycle gate refuse a worker stopping its OWN backend while
    still allowing it to stop a DIFFERENT instance (whose backend is not its ancestor).
    """
    if not pid:
        return False
    import os  # noqa: PLC0415

    import psutil  # noqa: PLC0415

    pid = int(pid)
    me = os.getpid()
    if pid == me:
        return True
    try:
        return any(anc.pid == pid for anc in psutil.Process(me).parents())
    except (psutil.Error, OSError) as exc:
        # Fail OPEN: we could not read the live tree. The lifecycle gate then does not refuse,
        # so a worker whose chain to the backend is severed (an intermediate process exited, or
        # it was detached with setsid/nohup and reparented to init) is NOT stopped here. That
        # residual belongs to L1 (OS containment). Log it so the gap is observable, not silent.
        logger.warning("runs_under(%s): could not read process ancestry (%s); failing open", pid, exc)
        return False


def partition(pids: Iterable[int]) -> tuple[list[int], list[int]]:
    """``(allowed, refused)`` over *pids*, de-duplicated and order-preserving. ``refused`` are
    the protected FlowPad pids; ``allowed`` is everything else and is safe to kill."""
    ordered = list(dict.fromkeys(int(p) for p in pids))
    refused = protected(ordered)
    return [p for p in ordered if p not in refused], [p for p in ordered if p in refused]


__all__ = [
    "PortGuardRefused",
    "caller_is_worker",
    "foreign_flowpad_pids",
    "live_backend_pid",
    "live_backend_pids",
    "partition",
    "protected",
    "runs_under",
]
