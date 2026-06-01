"""Predicates over the two-axis (ProcessStatus, WorkerStatus) model, plus the
derived ``WorkerMode`` (Interactive / CLI).

Central place for questions like "can the user send now?" and "which worker
flavour is running?" — so callers never have to recombine lifecycle + worker
state (or re-derive the mode from ``visible``) by hand.

See ``agentic_process_lifecycle.py`` (ProcessStatus) and ``agent_status.py``
(WorkerStatus) for the canonical definitions.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from flow_sdk._compat import StrEnum
from flow_sdk.builtin.worker_status import (
    WorkerStatus,
    is_running as is_worker_running,
    is_terminal as is_worker_terminal,
)
from flow_sdk.builtin.process_lifecycle import (
    ProcessStatus,
    is_running as is_process_running,
    is_startable as is_process_startable,
)

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess


__all__ = [
    "is_ready_for_input",
    "is_process_running",
    "is_process_startable",
    "is_worker_running",
    "is_worker_terminal",
    "WorkerMode",
    "get_worker_mode",
]


class WorkerMode(StrEnum):
    """Which mode the worker is currently running in.

    Derived from ``visible``; not stored as its own field. The routing is:
      - ``visible is True``  → ``INTERACTIVE`` (PTY worker, xterm in the dock)
      - ``visible is False`` → ``CLI`` (headless ``claude -p`` subprocess per turn)

    ``session_id`` survives both directions — both modes write the same
    ``~/.claude/projects/<encoded-cwd>/<sid>.jsonl``. Switching is therefore
    two-way: opening a shell tab flips ``visible=True`` (via the ``open``
    action); closing the tab flips it back to ``False`` (via ``close``).
    """

    INTERACTIVE = "interactive"
    CLI = "cli"


def get_worker_mode(process: "AgenticProcess") -> WorkerMode:
    """Derive ``WorkerMode`` from ``process.visible``."""
    return WorkerMode.INTERACTIVE if process.visible else WorkerMode.CLI


_READY_WORKER_STATES: frozenset[WorkerStatus] = frozenset({
    WorkerStatus.IDLE,
    WorkerStatus.COMPLETE,
    WorkerStatus.INTERRUPTED,
})


def is_ready_for_input(
    process: "AgenticProcess",
    worker_status: WorkerStatus | None = None,
) -> bool:
    """True when a caller can send a new user prompt to the worker.

    Contract (also enforced by the vitest / pytest truth-table tests):

        is_ready_for_input(p)  ⇔
            p.status == ProcessStatus.RUNNING
            AND  worker_status ∈ {IDLE, COMPLETE, INTERRUPTED}

    Special case: ``worker_status is None`` means the transcript hasn't been
    discovered yet. If the process has no ``session_id``, it has never been
    prompted — treat as ready. Otherwise Claude was just launched and the
    JSONL hasn't been written yet — treat as busy.

    The ``worker_status`` argument is optional — if the caller has already
    resolved it (e.g. inside a serializer), pass it to avoid a second tail-read.
    """
    if process.status != ProcessStatus.RUNNING.value:
        return False
    if worker_status is None:
        # Don't trigger a transcript read on every call; only resolve if the
        # caller didn't pre-compute it. Callers that do serve hot paths should
        # pass ``worker_status`` explicitly.
        resolved = process._discover_status_from_transcript()
    else:
        resolved = worker_status
    if resolved is None:
        return not bool(process.session_id)
    return resolved in _READY_WORKER_STATES
