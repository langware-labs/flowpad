"""Predicates over the two-axis (ProcessStatus, WorkerStatus) model.

Central place for questions like "can the user send now?" — so callers never
have to recombine lifecycle + worker state by hand.

See ``agentic_process_lifecycle.py`` (ProcessStatus) and ``agent_status.py``
(WorkerStatus) for the canonical definitions.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from flow_sdk.fs_records.agent_status import (
    WorkerStatus,
    is_running as is_worker_running,
    is_terminal as is_worker_terminal,
)
from flow_sdk.fs_records.agentic_process_lifecycle import (
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
]


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
