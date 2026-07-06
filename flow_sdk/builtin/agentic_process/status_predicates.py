"""Predicates over the two-axis (ProcessStatus, WorkerStatus) model, plus the
derived ``WorkerMode`` (Interactive / CLI).

Central place for the two questions the whole system gates on:

  - **"is a turn in flight?"** → :func:`is_turn_busy`. The single source of truth
    for the ``busy`` boolean. It is serialized as its own ``busy`` field (never
    folded into ``status``), and feeds the ``switch-mode`` / ``restart`` 409 guard
    and every frontend input/toggle gate.
  - **"which worker flavour is running?"** → :func:`get_worker_mode`.

``busy`` is a function of process state (lock + in-flight + worker activity),
NOT of any single stored field, so callers never recombine lifecycle + worker
state by hand.

See ``process_lifecycle.py`` (ProcessStatus) and ``worker_status.py``
(WorkerStatus) for the canonical enum definitions, and
``docs/agent/agentic_process_statuses.md`` for the model overview.
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
    "is_turn_busy",
    "is_ready_from_busy",
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


# ---------------------------------------------------------------------------
# The busy predicate — single source of truth for "is a turn in flight?"
#
# Mirrored byte-for-byte in TS by the ``worker_busy`` set in
# ``test_fixtures/status_sets.json`` (consumed by ``isBusy`` / the wire
# projection on both sides).
# ---------------------------------------------------------------------------

# Raw worker statuses that mean "the worker is mid-turn and the user must wait".
# NOTE api_error is deliberately NOT here: an API error is something the user can
# just re-prompt past, so it maps to a *ready* process status. While a turn is
# genuinely retrying the prompt lock (or ``_turn_in_flight``) is held, which
# keeps the process ``busy`` regardless of this set.
_BUSY_WORKER_STATUSES: frozenset[WorkerStatus] = frozenset({
    WorkerStatus.INITIALIZING,
    WorkerStatus.WORKING,
    WorkerStatus.THINKING,
    WorkerStatus.TOOL_CALL,
    WorkerStatus.TOOL_RUNNING,
})


def is_turn_busy(
    process: "AgenticProcess",
    worker_status: WorkerStatus | None = None,
) -> bool:
    """True when a turn is in flight — the single ``busy`` boolean.

    ``busy`` is a function of process state, resolved from three signals (any
    one → busy):

      1. the per-process prompt lock is held (headless / chat-over-PTY turn), OR
      2. ``_turn_in_flight`` is set (a worker spinning up before its transcript
         lands), OR
      3. the raw ``worker_status`` is a mid-turn activity state
         (``_BUSY_WORKER_STATUSES``).

    A native-xterm turn holds no lock and sets no ``_turn_in_flight`` flag, so
    (3) is the only signal that keeps it ``busy`` — that is why the ``switch-mode``
    409 must key on this predicate, not the lock alone.

    ``worker_status`` is optional — if the caller already resolved it (e.g. the
    serializer), pass it to avoid a second transcript tail-read.
    """
    # Lazy import breaks the cycle: agentic_process imports this leaf module at
    # load time. ``_PROMPT_LOCKS`` is the single runtime source; both headless
    # (``prompt``) and chat-over-PTY turns hold it for the turn's duration.
    try:
        from flow_sdk.builtin.agentic_process.agentic_process import prompt_lock_locked
    except Exception:
        prompt_lock_locked = None
    if prompt_lock_locked is not None and prompt_lock_locked(process.id):
        return True
    if getattr(process, "_turn_in_flight", False):
        return True
    resolved = worker_status if worker_status is not None else process.fetch_worker_status()
    return resolved in _BUSY_WORKER_STATUSES


def is_ready_from_busy(status: str, busy: bool) -> bool:
    """Combine the two orthogonal axes into "can send now": the worker is fully up
    (``status == RUNNING``, not the STARTING/STOPPING bookends) and no turn is in
    flight. The single definition of the RUNNING-literal predicate — callers that
    have already computed ``busy`` (the serializer, ``get_status``) pass it here to
    avoid re-probing ``is_turn_busy``; ``is_ready_for_input`` computes ``busy`` for
    callers that only hold the process.
    """
    return status == ProcessStatus.RUNNING.value and not busy


def is_ready_for_input(
    process: "AgenticProcess",
    worker_status: WorkerStatus | None = None,
) -> bool:
    """True when a caller can send a new user prompt to the worker.

    Contract (also enforced by the vitest / pytest truth-table tests):

        is_ready_for_input(p)  ⇔  p.status == RUNNING and not is_turn_busy(p)

    The ``worker_status`` argument is optional — pass a pre-resolved value to avoid
    a second tail-read.
    """
    return is_ready_from_busy(process.status, is_turn_busy(process, worker_status))
