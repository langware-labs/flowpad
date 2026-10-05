"""History rows → runs a person can read.

The trigger log stays as it is (JSONL per rule name). This module is its
reader: it filters by ``trigger_id`` (rule names repeat, and a rename leaves the
old file behind), merges an event fire's start row with its ``tag_fire_done``
row, turns each row into a status and a "why" in words, and — at read time —
asks the agent run a fire started how it ended. Nothing is written back.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable, Optional

from flow_sdk.schema.data_spec.automation_spec import AutomationRun, RunStatus

logger = logging.getLogger(__name__)

#: Row ``hook_event`` → automation kind.
_KIND_BY_EVENT = {
    "schedule_fire": "schedule",
    "tag_fire": "event",
    "tag_suppressed": "event",
    "storm_suppressed": "event",
    "file_change": "file",
    "hook_fire": "agent_hook",
}

#: Why a fire was skipped, in words.
SKIP_WORDS = {
    "storm": "Skipped: it fired too often in one minute",
    "confirm_failed": "Skipped: the check before running found nothing",
    "disabled": "Skipped: the automation was off",
    "self_loop": "Skipped: it would have triggered itself",
    "already_fired": "Skipped: it only runs once, and it already ran",
}


def rows_for(trigger_id: Optional[str], name: Optional[str], rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """This automation's rows. Rows written before ``trigger_id`` existed match by name."""
    out = []
    for row in rows:
        rid = row.get("trigger_id")
        if rid:
            if trigger_id and rid == trigger_id:
                out.append(row)
        elif name and row.get("rule_name") == name:
            out.append(row)
    return out


def _why(row: dict[str, Any], catalog: dict[str, tuple[str, str]]) -> str:
    event = row.get("hook_event") or ""
    if row.get("reason_code"):
        return SKIP_WORDS.get(row["reason_code"], row.get("reason") or "Skipped")
    if row.get("is_test"):
        prefix = "Test run"
    else:
        prefix = ""
    if event == "schedule_fire":
        text = "Scheduled"
    elif event in ("tag_fire", "tag_fire_done"):
        tag = row.get("cause_tag") or ""
        title = catalog.get(tag, ("", ""))[0]
        text = title or (f"Event {tag}" if tag else "An event")
    elif event == "file_change":
        path = row.get("changed_path") or ""
        total = row.get("changes_total") or 1
        text = f"A file changed: {path}" if total == 1 else f"{total} files changed, first {path}"
    elif event == "hook_fire":
        text = f"Agent hook {row.get('event_kind') or ''}".strip()
    else:
        text = row.get("reason") or event or "Fired"
    return f"{prefix}: {text}" if prefix else text


def _status(row: dict[str, Any], done: Optional[dict[str, Any]]) -> RunStatus:
    if row.get("reason_code") or (row.get("trigger") is False and row.get("hook_event", "").endswith("suppressed")):
        return "skipped"
    outcome = done or row
    if outcome.get("error"):
        return "failed"
    if row.get("hook_event") == "tag_fire" and done is None:
        # A row from before the done row existed (no spec_hash) never gets one:
        # it started, and that is all anyone recorded.
        return "running" if row.get("spec_hash") else "launched"
    if outcome.get("agentic_process_id"):
        return "launched"
    return "succeeded"


def fold(rows: Iterable[dict[str, Any]], catalog: Optional[dict[str, tuple[str, str]]] = None) -> list[AutomationRun]:
    """Newest-first rows → newest-first runs. An event fire's two rows become one run."""
    if catalog is None:
        from flow_sdk.automations.describe import event_catalog  # noqa: PLC0415

        catalog = event_catalog()
    rows = list(rows)
    done_by_event = {r.get("event_id"): r for r in rows if r.get("hook_event") == "tag_fire_done" and r.get("event_id")}
    runs: list[AutomationRun] = []
    for row in rows:
        if row.get("hook_event") == "tag_fire_done":
            continue
        done = done_by_event.get(row.get("event_id")) if row.get("hook_event") == "tag_fire" else None
        outcome = done or row
        actions = [a.get("action_type") if isinstance(a, dict) else str(a) for a in row.get("actions") or []]
        runs.append(AutomationRun(
            id=str(row.get("id") or ""),
            trigger_id=row.get("trigger_id"),
            automation_name=row.get("rule_name") or "",
            kind=_KIND_BY_EVENT.get(row.get("hook_event") or ""),
            ts=str(row.get("ts") or ""),
            status=_status(row, done),
            is_test=bool(row.get("is_test")),
            why=_why(row, catalog),
            reason_code=row.get("reason_code"),
            error=outcome.get("error"),
            duration_ms=outcome.get("duration_ms"),
            agentic_process_id=outcome.get("agentic_process_id"),
            event_id=row.get("event_id"),
            cause_event_id=row.get("cause_event_id"),
            cause_tag=row.get("cause_tag"),
            cause_target=row.get("cause_target"),
            cause_data=row.get("cause_data"),
            changed_path=row.get("changed_path"),
            changes_total=row.get("changes_total"),
            actions=[a for a in actions if a],
            spec_hash=outcome.get("spec_hash") or row.get("spec_hash"),
        ))
    return runs


def process_outcome(status: Optional[str], exit_code: Optional[int]) -> tuple[RunStatus, Optional[str]]:
    """An agent run's own state → the run's status, plus an error when it failed."""
    if status in ("starting", "running", "stopping"):
        return "running", None
    if status == "failed":
        return "failed", "The agent stopped with an error." + (f" Exit code {exit_code}." if exit_code else "")
    if status == "stopped":
        if exit_code:
            return "failed", f"The agent exited with code {exit_code}."
        return "succeeded", None
    return "launched", None


async def join_processes(runs: list[AutomationRun]) -> list[AutomationRun]:
    """Replace ``launched`` with how the agent run actually ended. One lookup per run."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess  # noqa: PLC0415

    out: list[AutomationRun] = []
    for run in runs:
        if run.status != "launched" or not run.agentic_process_id:
            out.append(run)
            continue
        try:
            proc = await AgenticProcess.get_by_id(run.agentic_process_id)
        except Exception:  # noqa: BLE001 — a missing run reads as "launched", never an error
            proc = None
        if proc is None:
            out.append(run)
            continue
        status, error = process_outcome(str(proc.status or ""), proc.exit_code)
        out.append(run.model_copy(update={"status": status, "error": run.error or error,
                                          "process_status": str(proc.status or "")}))
    return out
