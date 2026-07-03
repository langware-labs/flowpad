"""ProcessStatus — backend-owned control-plane FSM for the AgenticProcess container.

Part of the two-axis status model:

- ``ProcessStatus`` (this file) — app/user-level lifecycle of the process
  container. The FSM is **stored** and its transitions are explicit
  (NEW → STARTING → RUNNING → STOPPING → STOPPED, any → FAILED). ``RUNNING`` is
  the only stored "live" value.

  On the **wire**, ``RUNNING`` is projected to one of two logical values by
  ``status_predicates.wire_status`` — ``READY`` (the worker can take the next
  user prompt) or ``BUSY`` (a turn is in flight). ``READY``/``BUSY`` are
  **never stored**; they exist only in serialized payloads. This is the
  "what does it mean" axis, shared identically across every worker vendor.
- ``WorkerStatus`` (``worker_status.py``) — raw "what we found" state of the
  worker running inside the process, in worker lingo. Derived from the vendor
  transcript on each serialize; never stored.

See ``docs/agent/agentic_process_statuses.md`` for the full model.
"""

from __future__ import annotations

from flow_sdk._compat import StrEnum


class ProcessStatus(StrEnum):
    NEW = "new"
    STARTING = "starting"
    # Stored "live" value. Never serialized directly — the wire projection
    # replaces it with READY / BUSY (see ``status_predicates.wire_status``).
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"

    # Wire-only logical projections of RUNNING. NEVER persisted; produced by the
    # serializer / ``status`` action so consumers gate input and the pty-mode
    # switch on a single ``status == "busy"`` boolean.
    READY = "ready"
    BUSY = "busy"


# Live states — accepts both the stored `running` and its wire projections
# `ready`/`busy` (plus the STARTING/STOPPING bookends), so `is_running` classifies
# a persisted OR a serialized value without the caller knowing which realm it holds.
_WIRE_RUNNING_STATUSES: frozenset[ProcessStatus] = frozenset({
    ProcessStatus.STARTING,
    ProcessStatus.RUNNING,
    ProcessStatus.READY,
    ProcessStatus.BUSY,
    ProcessStatus.STOPPING,
})

_STARTABLE_STATUSES: frozenset[ProcessStatus] = frozenset({
    ProcessStatus.NEW,
    ProcessStatus.STOPPED,
    ProcessStatus.FAILED,
})


def is_running(status: ProcessStatus) -> bool:
    """True while the process container is live.

    Accepts both the stored form (STARTING/RUNNING/STOPPING) and the wire
    projection (STARTING/READY/BUSY/STOPPING), so callers don't have to know
    whether they hold a persisted or serialized value.
    """
    return status in _WIRE_RUNNING_STATUSES


def is_startable(status: ProcessStatus) -> bool:
    """True when start() can be invoked (NEW/STOPPED/FAILED)."""
    return status in _STARTABLE_STATUSES
