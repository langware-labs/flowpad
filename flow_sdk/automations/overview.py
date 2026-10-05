"""The Automations list: every rule as a sentence with its health.

One call answers the whole list — the screen asks once, not once per rule —
so this reads every Trigger row, the whole fire log and the workflow
references in one pass each, then joins them in memory.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from flow_sdk.schema.data_spec.automation_spec import AutomationGroup, AutomationRun, AutomationSummary

logger = logging.getLogger(__name__)

#: How many recent real runs "2 of the last 5 failed" looks at.
RECENT_WINDOW = 5
#: Rows read from each rule's log for the list: its recent window plus room for
#: the latest test run ("Not tested yet" looks for one with the current spec).
ROWS_PER_RULE = 50
#: How long the "which workflows does this start" map is reused between polls.
WORKFLOWS_TTL_S = 30.0


def group_of(trigger: Any) -> AutomationGroup:
    """Flowpad's own, a project's, or the person's (everywhere)."""
    if trigger.is_builtin:
        return "builtin"
    return "project" if trigger.project_id else "mine"


def is_tested(trigger: Any, runs: list[AutomationRun]) -> bool:
    """Exercised as it is now: a test run, or a real run that did not fail, with this spec."""
    from flow_sdk.automations.fingerprint import spec_hash  # noqa: PLC0415

    current = spec_hash(trigger)
    return any(r.spec_hash == current and (r.is_test or r.status in ("succeeded", "launched", "running"))
               for r in runs)


_workflows_cache: tuple[float, dict[str, list[str]]] | None = None


async def workflows_by_trigger() -> dict[str, list[str]]:
    """trigger id → names of the enabled workflows it starts. Reused for a few
    seconds: the list polls, and workflows change far less often than that."""
    import time  # noqa: PLC0415

    global _workflows_cache
    if _workflows_cache and time.monotonic() - _workflows_cache[0] < WORKFLOWS_TTL_S:
        return _workflows_cache[1]
    out: dict[str, list[str]] = {}
    try:
        from flow_sdk.builtin.graph_workflow import GraphWorkflow  # noqa: PLC0415
        from flow_sdk.graph_workflow_manager import get_graph_workflow_manager  # noqa: PLC0415

        manager = get_graph_workflow_manager()
        for entity in await GraphWorkflow.get_all({}):
            loaded = await manager.load_flow(entity.id, entity)
            if not (loaded and loaded.enabled):
                continue
            for tid in loaded.doc.trigger_ids():
                out.setdefault(tid, []).append(entity.name or entity.id)
    except Exception:  # noqa: BLE001 — workflows are one more line in the sentence, never a failure
        logger.debug("workflow lookup for automations failed", exc_info=True)
    _workflows_cache = (time.monotonic(), out)
    return out


async def summarize(trigger: Any, runs: list[AutomationRun], *, names: Any = None,
                    workflows: Optional[list[str]] = None,
                    catalog: Optional[dict[str, tuple[str, str]]] = None,
                    last_joined: Optional[AutomationRun] = None) -> AutomationSummary:
    from flow_sdk.automations.describe import describe_then, describe_when, kind_of  # noqa: PLC0415
    from flow_sdk.automations.runs import join_processes  # noqa: PLC0415

    real = [r for r in runs if not r.is_test and r.status != "skipped"][:RECENT_WINDOW]
    last = runs[0] if runs else None
    if last is not None and last_joined is None:
        last = (await join_processes([last]))[0]
    elif last_joined is not None:
        last = last_joined
    group = group_of(trigger)
    next_run = trigger.next_run.isoformat() if getattr(trigger, "next_run", None) and trigger.enabled else None
    return AutomationSummary(
        id=str(trigger.id),
        name=trigger.name or "",
        description=trigger.description or "",
        kind=kind_of(trigger),
        group=group,
        project_id=trigger.project_id or None,
        enabled=bool(trigger.enabled),
        when=describe_when(trigger, catalog),
        then=await describe_then(trigger, names=names, workflows=workflows),
        last_run=last,
        recent_failures=sum(1 for r in real if r.status == "failed"),
        recent_runs=len(real),
        next_run=next_run,
        fires=int(trigger.counter or 0),
        tested=is_tested(trigger, runs),
        read_only=group == "builtin",
        asset_ref=trigger.asset_ref or None,
    )


async def overview(*, include_inactive: bool = False) -> list[AutomationSummary]:
    """Every automation, by name (the screen groups them)."""
    from flow_sdk.automations.describe import _Names, event_catalog  # noqa: PLC0415
    from flow_sdk.automations.runs import RowIndex, fold, join_processes  # noqa: PLC0415
    from flow_sdk.builtin.trigger import Trigger  # noqa: PLC0415
    from flow_sdk.builtin.trigger_arming import is_foreign_copy  # noqa: PLC0415
    from flow_sdk.fs_store.operations.trigger_log import discover  # noqa: PLC0415

    triggers = [t for t in await Trigger.get_all({})
                if include_inactive or not is_foreign_copy(t.asset_ref)]
    rows = RowIndex(discover(None, limit=ROWS_PER_RULE * max(1, len(triggers)), per_rule=ROWS_PER_RULE))
    catalog = event_catalog()
    names = _Names()
    flows = await workflows_by_trigger()
    folded = [(trigger, fold(rows.rows_for(str(trigger.id), trigger.name), catalog)) for trigger in triggers]
    # Every automation's newest run asks its agent run how it ended — together.
    lasts = await join_processes([runs[0] for _, runs in folded if runs])
    joined = {run.id: run for run in lasts}
    out: list[AutomationSummary] = []
    for trigger, runs in folded:
        out.append(await summarize(trigger, runs, names=names, workflows=flows.get(str(trigger.id)),
                                   catalog=catalog, last_joined=joined.get(runs[0].id) if runs else None))
    # A stable order: rows must not jump while someone aims at one (the list
    # polls, and ordering by last run moved them every few seconds under load).
    out.sort(key=lambda s: (s.name.casefold(), s.id))
    return out
