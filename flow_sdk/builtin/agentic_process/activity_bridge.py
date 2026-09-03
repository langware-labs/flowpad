"""A running agentic process IS an activity.

This is the one producer wired in phase 1, and it is what gives the mechanism a visible
home: with a process reporting as an activity, the footer chip has a single list and a
single count covering agents and everything else, rather than two stores that have to be
kept in agreement.

It is a **projection**, not a second source of truth. Everything here is already computed
for the ``ProcessStatusReport`` on each debounce flush (`AgenticProcess._emit_status_report`);
this mirrors that snapshot onto the process's ``Activity`` so one vocabulary describes an
indexing walk and a Claude session alike. The report carries running TOTALS, so it uses
``set_counter`` rather than the delta verb — the "never move a counter backwards" policy
lives on ``Activity`` where every producer inherits the same answer. The existing status-report field and its own
``progress_report`` emit are untouched — folding the two is a phase-2 question.

No icon is set. An activity's icon falls back to its scope entity's ``TypeInfo.icon``, and
the scope here IS the process, so a process row gets the process glyph without this module
duplicating the type registry.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from flow_sdk.activity import Activity, ActivityState
from flow_sdk.builtin.worker_status import WorkerStatus
from flow_sdk.builtin.worker_status import is_terminal as is_worker_terminal

logger = logging.getLogger(__name__)

#: One root per process, addressed within the process's own scope. The name is generic
#: because the scope already says which process this is.
PROCESS_ACTIVITY_PATH = "process"

#: Which counters from the status report are worth a row on the chip, mapped to the name
#: the activity carries. Deliberately a whitelist: ``ProcessCounters`` grows fields for its
#: own reasons, and every one added here costs wire on every tick of every live process.
#: ``total_tokens`` is a computed property rather than a field, so it is read separately.
_COUNTER_FIELDS = {"assistant_messages": "messages", "tool_calls": "tool_calls"}


def scope_for(process_id: Any) -> str:
    return f"agentic_process-{process_id}"


def _state_for(worker_status: "Optional[WorkerStatus]") -> "Optional[ActivityState]":
    """Map a worker status to an activity state, or ``None`` to leave it alone.

    Only the states a person acts on are mapped. The many active statuses
    (``working`` / ``thinking`` / ``tool_call`` / ``tool_running``) are all just "running"
    to someone reading a chip, and mapping each one would make the row flicker between
    words that mean the same thing.
    """
    if worker_status is None:
        return None
    if worker_status == WorkerStatus.PENDING_USER:
        # The worker asked a question and handed control back. That is a person's cue,
        # which is exactly what `blocked` means.
        return ActivityState.BLOCKED
    if worker_status == WorkerStatus.ERROR:
        return ActivityState.FAILED
    if worker_status == WorkerStatus.INTERRUPTED:
        return ActivityState.INTERRUPTED
    if worker_status == WorkerStatus.COMPLETE:
        return ActivityState.COMPLETED
    if is_worker_terminal(worker_status):
        return ActivityState.COMPLETED
    return ActivityState.RUNNING


def sync_process_activity(
    process_id: Any,
    *,
    label: "Optional[str]" = None,
    worker_status: "Optional[WorkerStatus]" = None,
    report: "Optional[dict]" = None,
    focused_asset: "Optional[str]" = None,
) -> None:
    """Mirror one status-report flush onto the process's activity.

    Never raises: progress reporting is not a reason for a turn to fail, and this runs
    inside the transcript debounce path where an exception would be far from its cause.
    """
    try:
        act = Activity.get(PROCESS_ACTIVITY_PATH, scope=scope_for(process_id))
        if act.is_terminal:
            return

        if label and act.label_text != label:
            act.label(label)
        if focused_asset is not None and act.current_item != focused_asset:
            act.current(focused_asset)

        counters = (report or {}).get("counters") or {}
        for source_field, name in _COUNTER_FIELDS.items():
            value = counters.get(source_field)
            if isinstance(value, int):
                act.set_counter(name, value)
        tokens = _total_tokens(counters)
        if tokens is not None:
            act.set_counter("tokens", tokens)

        target = _state_for(worker_status)
        if target is None or target == act.state:
            return

        if target == ActivityState.BLOCKED:
            act.block("waiting for you")
        elif target == ActivityState.RUNNING:
            act.resume()
        elif target == ActivityState.FAILED:
            act.fail("worker ended in error")
        elif target == ActivityState.INTERRUPTED:
            act.cancel("interrupted")
        elif target == ActivityState.COMPLETED:
            act.done()
    except Exception:  # noqa: BLE001 — a projection must never break the turn it mirrors
        logger.debug("activity bridge failed for process %s", process_id, exc_info=True)


def _total_tokens(counters: dict) -> "Optional[int]":
    """``ProcessCounters.total_tokens`` is a property, so a dumped report has the four
    disjoint buckets and not the sum. Add them here rather than teaching the chip to."""
    parts = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")
    values = [counters.get(p) for p in parts]
    if not any(isinstance(v, int) for v in values):
        return None
    return sum(v for v in values if isinstance(v, int))


def end_process_activity(process_id: Any, *, message: "Optional[str]" = None) -> None:
    """End the process's activity — on close, delete, or a terminal lifecycle status.

    Ending the ROOT evicts the tree, so the chip stops counting a process that is gone
    even if no further status report ever arrives.
    """
    try:
        Activity.get(PROCESS_ACTIVITY_PATH, scope=scope_for(process_id)).done(message)
    except Exception:  # noqa: BLE001
        logger.debug("activity bridge close failed for process %s", process_id, exc_info=True)


__all__ = ["PROCESS_ACTIVITY_PATH", "end_process_activity", "scope_for", "sync_process_activity"]
