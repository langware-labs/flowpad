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
    "tag_declined": "event",
    "tag_suppressed": "event",
    "storm_suppressed": "event",
    "file_change": "file",
    "hook_fire": "agent_hook",
}

#: The gate's two reason codes: a fire that was asked and not caught, or could not be asked.
DECLINED_CODES: frozenset[str] = frozenset({"decision_no", "decision_unavailable"})

#: Why a fire was skipped, in words.
SKIP_WORDS = {
    "storm": "Skipped: it fired too often in one minute",
    "confirm_failed": "Skipped: the check before running found nothing",
    "disabled": "Skipped: the automation was off",
    "self_loop": "Skipped: it would have triggered itself",
    "already_fired": "Skipped: it only runs once, and it already ran",
    "decision_no": "Passed over: not what the rule catches",
    "decision_unavailable": "Not decided: the Decision API could not be asked",
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


class RowIndex:
    """History rows grouped once by ``trigger_id`` (and by name for legacy rows) —
    so the list looks each automation up instead of scanning every row per automation."""

    def __init__(self, rows: Iterable[dict[str, Any]]) -> None:
        self._by_id: dict[str, list[dict[str, Any]]] = {}
        self._by_name: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            if row.get("trigger_id"):
                self._by_id.setdefault(row["trigger_id"], []).append(row)
            elif row.get("rule_name"):
                self._by_name.setdefault(row["rule_name"], []).append(row)

    def rows_for(self, trigger_id: Optional[str], name: Optional[str]) -> list[dict[str, Any]]:
        """Same answer as the module-level ``rows_for``, newest first."""
        found = self._by_id.get(trigger_id or "", []) + self._by_name.get(name or "", [])
        return sorted(found, key=lambda r: str(r.get("ts") or ""), reverse=True)


def _why(row: dict[str, Any], catalog: dict[str, tuple[str, str]]) -> str:
    """Why it ran, in English — for the CLI and agents. The UI renders its own
    words from the structured fields (``reason_code``, ``kind``, ``cause_*``,
    ``is_test``), so nothing here is meant to be parsed."""
    event = row.get("hook_event") or ""
    code = row.get("reason_code")
    if code:
        words = SKIP_WORDS.get(code, row.get("reason") or "Skipped")
        reason = (row.get("decision") or {}).get("reason") or (row.get("reason") if code in DECLINED_CODES else "")
        return f"{words}: {reason}" if reason else words
    if event == "schedule_fire":
        return "Scheduled"
    if event in ("tag_fire", "tag_fire_done"):
        tag = row.get("cause_tag") or ""
        return catalog.get(tag, ("", ""))[0] or (f"Event {tag}" if tag else "An event")
    if event == "file_change":
        path = row.get("changed_path") or ""
        total = row.get("changes_total") or 1
        return f"A file changed: {path}" if total == 1 else f"{total} files changed, first {path}"
    if event == "hook_fire":
        return f"Agent hook {row.get('event_kind') or ''}".strip()
    return row.get("reason") or event or "Fired"


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
            decision=row.get("decision") or outcome.get("decision"),
            subject_id=row.get("subject_id") or outcome.get("subject_id"),
            wizard=outcome.get("wizard"),
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


#: Agent runs that have ended, by id → (status, exit_code). An ended run never
#: changes, so the screen's 5-second polls ask the database for each one once.
_ended: dict[str, tuple[str, Optional[int]]] = {}
_ENDED_CAP = 5000


async def _process_state(pid: str) -> Optional[tuple[str, Optional[int]]]:
    if pid in _ended:
        return _ended[pid]
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess  # noqa: PLC0415

    try:
        proc = await AgenticProcess.get_by_id(pid)
    except Exception:  # noqa: BLE001 — a missing run reads as "launched", never an error
        return None
    if proc is None:
        return None
    state = (str(proc.status or ""), proc.exit_code)
    if state[0] in ("stopped", "failed"):
        if len(_ended) >= _ENDED_CAP:
            _ended.clear()
        _ended[pid] = state
    return state


async def join_processes(runs: list[AutomationRun]) -> list[AutomationRun]:
    """Replace ``launched`` with how the agent run actually ended — looked up together."""
    import asyncio  # noqa: PLC0415

    pids = sorted({r.agentic_process_id for r in runs if r.status == "launched" and r.agentic_process_id})
    states = dict(zip(pids, await asyncio.gather(*(_process_state(p) for p in pids))))
    out: list[AutomationRun] = []
    for run in runs:
        state = states.get(run.agentic_process_id or "") if run.status == "launched" else None
        if state is None:
            out.append(run)
            continue
        status, error = process_outcome(*state)
        out.append(run.model_copy(update={"status": status, "error": run.error or error, "process_status": state[0]}))
    return out
