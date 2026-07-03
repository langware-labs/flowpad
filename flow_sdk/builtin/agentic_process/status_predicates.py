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

    Derived from the *transport* ``pty_mode``, not tab ``visible``:
      - ``pty_mode is True``  → ``INTERACTIVE`` (PTY worker, xterm in the dock)
      - ``pty_mode is False`` → ``CLI`` (headless ``claude -p`` subprocess per turn)

    A hidden live PTY (``visible=False`` but ``pty_mode=True``) is still an
    INTERACTIVE worker — visibility is only tab chrome. ``session_id`` survives
    both directions (both modes write the same
    ``~/.claude/projects/<encoded-cwd>/<sid>.jsonl``), so switching is two-way via
    the ``switch-mode`` action.
    """

    INTERACTIVE = "interactive"
    CLI = "cli"


def get_worker_mode(process: "AgenticProcess") -> WorkerMode:
    """Derive ``WorkerMode`` from the transport intent ``process.pty_mode``."""
    return WorkerMode.INTERACTIVE if process.pty_mode else WorkerMode.CLI


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
    discovered yet. The worker is busy only when a turn is actually in flight
    (the headless drivers set ``_turn_in_flight`` for the duration of a turn);
    otherwise a RUNNING process with no derivable status is spawned-and-idle,
    ready for its first prompt. (Previously gated on ``session_id`` presence,
    which mis-read every freshly-spawned session as busy because the Claude
    driver mints a ``session_id`` eagerly, before any turn runs.)

    The ``worker_status`` argument is optional — if the caller has already
    resolved it (e.g. inside a serializer), pass it to avoid a second tail-read.
    """
    if process.status != ProcessStatus.RUNNING.value:
        return False
    if worker_status is None:
        # Don't trigger a transcript read on every call; only resolve if the
        # caller didn't pre-compute it. Callers that do serve hot paths should
        # pass ``worker_status`` explicitly.
        resolved = process.fetch_worker_status()
    else:
        resolved = worker_status
    if resolved is None:
        return not getattr(process, "_turn_in_flight", False)
    return resolved in _READY_WORKER_STATES
