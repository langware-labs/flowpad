"""ProcessStatus — backend-owned control-plane FSM for the AgenticProcess container.

Part of the two-axis status model:

- ``ProcessStatus`` (this file) — app/user-level lifecycle of the process container.
  Stored. Transitions are explicit (NEW → STARTING → RUNNING → STOPPING → STOPPED,
  any → FAILED). Six values.
- ``WorkerStatus`` (``agent_status.py``) — expert-level state of the worker running
  inside the process. Derived from the Claude transcript JSONL on each serialize.
  Only meaningful when ``ProcessStatus ∈ {RUNNING, STOPPING, STOPPED}``.
"""

from __future__ import annotations

from flow_sdk._compat import StrEnum


class ProcessStatus(StrEnum):
    NEW = "new"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"


_RUNNING_STATUSES: frozenset[ProcessStatus] = frozenset({
    ProcessStatus.STARTING,
    ProcessStatus.RUNNING,
    ProcessStatus.STOPPING,
})

_STARTABLE_STATUSES: frozenset[ProcessStatus] = frozenset({
    ProcessStatus.NEW,
    ProcessStatus.STOPPED,
    ProcessStatus.FAILED,
})


def is_running(status: ProcessStatus) -> bool:
    """True while the process container is in a running state (STARTING/RUNNING/STOPPING)."""
    return status in _RUNNING_STATUSES


def is_startable(status: ProcessStatus) -> bool:
    """True when start() can be invoked (NEW/STOPPED/FAILED)."""
    return status in _STARTABLE_STATUSES
