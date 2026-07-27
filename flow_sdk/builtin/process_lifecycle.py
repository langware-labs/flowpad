"""ProcessStatus — backend-owned control-plane FSM for the AgenticProcess container.

Part of the status model:

- ``ProcessStatus`` (this file) — app/user-level lifecycle of the process
  container. The FSM is **stored** and its transitions are explicit
  (NEW → STARTING → RUNNING → STOPPING → STOPPED, any → FAILED). ``RUNNING`` is
  the single "live" value, emitted verbatim on the wire (no projection).

  "Is a turn in flight?" is a **separate**, orthogonal axis — the ``busy``
  boolean, derived per read by ``status_predicates.is_turn_busy`` and serialized
  alongside ``status`` as its own field. It is never folded into this FSM.
- ``WorkerStatus`` (``worker_status.py``) — raw "what we found" state of the
  worker running inside the process, in worker lingo. Derived from the vendor
  transcript on each serialize; never stored.

See ``docs/agent/agentic_process_statuses.md`` for the full model.
"""

from __future__ import annotations

import os
import signal
from pathlib import Path

from flow_sdk._compat import StrEnum

BACKEND_RESTART_MARKER_FILENAME = ".backend-restart-requested"
_RECOVERABLE_WORKER_SIGNALS = frozenset(
    int(signum)
    for name in ("SIGTERM", "SIGKILL", "SIGHUP")
    if (signum := getattr(signal, name, None)) is not None
)


def request_backend_restart(instance_dir: Path, server_pid: int) -> Path:
    """Mark one exact backend generation for intentional replacement."""
    if server_pid <= 0:
        raise ValueError("server_pid must be positive")
    marker = instance_dir / BACKEND_RESTART_MARKER_FILENAME
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(str(server_pid))
    return marker


def backend_restart_requested() -> bool:
    """Whether this exact backend generation is being replaced in-place."""
    from flow_sdk.instance_settings import get_instance_settings

    marker = (
        get_instance_settings().instance_dir
        / BACKEND_RESTART_MARKER_FILENAME
    )
    try:
        return int(marker.read_text().strip()) == os.getpid()
    except (OSError, ValueError):
        return False


def is_recoverable_worker_interruption(exit_code: int | None) -> bool:
    """Whether a signal exit is an external termination rather than a crash."""
    return (
        exit_code is not None
        and exit_code < 0
        and -exit_code in _RECOVERABLE_WORKER_SIGNALS
    )


def clear_backend_restart_request() -> None:
    """Consume a restart marker after the replacement backend has started."""
    from flow_sdk.instance_settings import get_instance_settings

    (get_instance_settings().instance_dir / BACKEND_RESTART_MARKER_FILENAME).unlink(missing_ok=True)


class ProcessStatus(StrEnum):
    NEW = "new"
    STARTING = "starting"
    # The "live" value. Both stored AND emitted on the wire — turn-in-flight is
    # now a *separate* ``busy`` boolean (derived per read from ``is_turn_busy``),
    # NOT a projection that overloads this lifecycle FSM. See
    # ``status_predicates.is_turn_busy`` and ``docs/agent/agentic_process_statuses.md``.
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"


# Live states — `running` is the single live value on both realms now (no more
# `ready`/`busy` projection), plus the STARTING/STOPPING bookends.
_WIRE_RUNNING_STATUSES: frozenset[ProcessStatus] = frozenset({
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
    """True while the process container is live (STARTING/RUNNING/STOPPING).

    Lifecycle only — "is a turn in flight?" is the orthogonal ``busy`` boolean
    (``is_turn_busy``), not a status value.
    """
    return status in _WIRE_RUNNING_STATUSES


def is_startable(status: ProcessStatus) -> bool:
    """True when start() can be invoked (NEW/STOPPED/FAILED)."""
    return status in _STARTABLE_STATUSES
