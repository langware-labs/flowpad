"""The Automations list: every rule as a sentence with its health.

One call answers the whole list — the screen asks once, not once per rule —
so this reads every Trigger row, the whole fire log and the workflow
references in one pass each, then joins them in memory.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Optional

from flow_sdk.schema.data_spec.automation_spec import (
    LOCAL_PLACE,
    AutomationGroup,
    AutomationPlace,
    AutomationRun,
    AutomationSummary,
    RunMark,
)

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

    global _workflows_cache
    if _workflows_cache and time.monotonic() - _workflows_cache[0] < WORKFLOWS_TTL_S:
        return _workflows_cache[1]
    out: dict[str, list[str]] = {}
    try:
        from flow_sdk.graph_workflow_manager import get_graph_workflow_manager  # noqa: PLC0415

        for entity, loaded in await get_graph_workflow_manager().enabled_flows():
            for tid in loaded.doc.trigger_ids():
                out.setdefault(tid, []).append(entity.name or entity.id)
    except Exception:  # noqa: BLE001 — workflows are one more line in the sentence, never a failure
        logger.debug("workflow lookup for automations failed", exc_info=True)
    _workflows_cache = (time.monotonic(), out)
    return out


def agent_of(trigger: Any) -> Optional[str]:
    """The agent a rule runs: its ``run_agent`` target, else the agent it belongs to."""
    for action in getattr(trigger, "actions", None) or []:
        if str(getattr(action, "action_type", "")) == "run_agent" and getattr(action, "target_type_id", None):
            return str(action.target_type_id)
    agent = ((getattr(trigger, "then", None) or {}).get("run_agent") or {}).get("agent")
    if agent:
        return str(agent)
    parent = str(getattr(trigger, "parent_type_id", "") or "")
    return parent if parent.startswith("agent-") else None


def place_of(trigger: Any, deployments: dict[str, Any]) -> AutomationPlace:
    """Where a rule runs, from its ``runs_on`` (``trigger_arming.runs_here``'s rule, in words).

    ``deployments`` maps the Deployment ids the rules name to the rows known here."""
    runs_on = str(getattr(trigger, "runs_on", "") or "")
    if not runs_on:
        return AutomationPlace(kind="local", label=LOCAL_PLACE.label, every_machine=True)
    deployment = deployments.get(runs_on)
    if deployment is not None and getattr(deployment, "is_local", False):
        return AutomationPlace(kind="local", label=LOCAL_PLACE.label, deployment_id=runs_on,
                               deployment_name=getattr(deployment, "name", None) or None)
    name = getattr(deployment, "name", None) or None
    return AutomationPlace(kind="cloud_machine", label=f"Cloud · {name or 'another machine'}",
                           deployment_id=runs_on, deployment_name=name)


async def deployments_named_by(triggers: list[Any]) -> dict[str, Any]:
    """The Deployment rows the rules' ``runs_on`` name, read together; an unknown id is left out."""
    from flow_sdk.builtin.trigger_arming import deployment_named  # noqa: PLC0415

    ids = sorted({str(t.runs_on) for t in triggers if getattr(t, "runs_on", None)})
    found = await asyncio.gather(*(deployment_named(i) for i in ids))
    return {i: d for i, d in zip(ids, found) if d is not None}


async def summarize(trigger: Any, runs: list[AutomationRun], *, names: Any = None,
                    workflows: Optional[list[str]] = None,
                    catalog: Optional[dict[str, tuple[str, str]]] = None,
                    last_joined: Optional[AutomationRun] = None,
                    place: AutomationPlace = LOCAL_PLACE) -> AutomationSummary:
    from flow_sdk.automations.describe import describe_then, describe_when, kind_of  # noqa: PLC0415
    from flow_sdk.automations.runs import join_processes  # noqa: PLC0415

    real = [r for r in runs if not r.is_test and r.status != "skipped"][:RECENT_WINDOW]
    passed_over = sum(1 for r in runs if r.reason_code == "decision_no")
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
        last_runs=[RunMark(id=r.id, ts=r.ts, status=r.status, agentic_process_id=r.agentic_process_id) for r in real],
        passed_over=passed_over,
        next_run=next_run,
        fires=int(trigger.counter or 0),
        tested=is_tested(trigger, runs),
        read_only=group == "builtin",
        asset_ref=trigger.asset_ref or None,
        place=place,
        agent_type_id=agent_of(trigger),
        parent_type_id=str(trigger.parent_type_id) if getattr(trigger, "parent_type_id", None) else None,
    )


async def overview(*, include_inactive: bool = False) -> list[AutomationSummary]:
    """Every automation, by name (the screen groups them)."""
    from flow_sdk.automations.describe import _Names, event_catalog  # noqa: PLC0415
    from flow_sdk.automations.runs import RowIndex, fold, join_processes  # noqa: PLC0415
    from flow_sdk.builtin.trigger import Trigger  # noqa: PLC0415
    from flow_sdk.builtin.trigger_arming import is_foreign_copy  # noqa: PLC0415
    from flow_sdk.fs_store.operations.trigger_log import discover  # noqa: PLC0415

    triggers = [t for t in await Trigger.every()
                if include_inactive or not is_foreign_copy(t.asset_ref)]
    rows = RowIndex(discover(None, limit=ROWS_PER_RULE * max(1, len(triggers)), per_rule=ROWS_PER_RULE))
    catalog = event_catalog()
    names = _Names()
    # Every agent a `then` names, resolved together once: the per-rule sentences below then read the
    # names from memory instead of one lookup after another.
    agents = {agent_of(t) for t in triggers}
    _, flows, deployments = await asyncio.gather(
        asyncio.gather(*(names.name(agent) for agent in agents if agent)),
        workflows_by_trigger(),
        deployments_named_by(triggers),
    )
    folded = [(trigger, fold(rows.rows_for(str(trigger.id), trigger.name), catalog)) for trigger in triggers]
    # Every automation's newest run asks its agent run how it ended — together.
    lasts = await join_processes([runs[0] for _, runs in folded if runs])
    joined = {run.id: run for run in lasts}
    out: list[AutomationSummary] = []
    for trigger, runs in folded:
        out.append(await summarize(trigger, runs, names=names, workflows=flows.get(str(trigger.id)),
                                   catalog=catalog, last_joined=joined.get(runs[0].id) if runs else None,
                                   place=place_of(trigger, deployments)))
    # A stable order: rows must not jump while someone aims at one (the list
    # polls, and ordering by last run moved them every few seconds under load).
    out.sort(key=lambda s: (s.name.casefold(), s.id))
    return out


# ── The Flowpad cloud's automations ───────────────────────────────────────────

#: How long the hub's answer (rows or why there are none) is reused between polls.
CLOUD_TTL_S = 15.0


@dataclass(frozen=True)
class CloudWarning:
    """Why the cloud's automations are not in the list: ``code`` is CLOUD_SIGNED_OUT or CLOUD_UNAVAILABLE."""

    code: str
    message: str


CloudAnswer = tuple[list[AutomationSummary], Optional[CloudWarning]]
_cloud_cache: tuple[float, CloudAnswer] | None = None
_cloud_inflight: Optional[asyncio.Task] = None


async def _fetch_cloud() -> CloudAnswer:
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
    from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind  # noqa: PLC0415

    try:
        data = await HubProxy.call("GET", "trigger", action="overview")
    except HubError as e:
        if e.kind is HubFailureKind.NOT_CONFIGURED:
            return [], None
        if e.kind is HubFailureKind.SIGNED_OUT:
            return [], CloudWarning("CLOUD_SIGNED_OUT", e.user_message())
        if e.status_code == 404:
            return [], CloudWarning("CLOUD_UNAVAILABLE", "The Flowpad cloud does not list automations yet.")
        return [], CloudWarning("CLOUD_UNAVAILABLE", e.user_message())
    rows: list[AutomationSummary] = []
    for raw in data if isinstance(data, list) else []:
        try:
            rows.append(AutomationSummary.model_validate({**raw, "source": "hub"}))
        except Exception:  # noqa: BLE001 — one unreadable row is left out, never the list
            logger.warning("cloud automation row unreadable: %r", (raw or {}).get("id"), exc_info=True)
    return rows, None


async def cloud_rows() -> CloudAnswer:
    """The hub's automations (``GET trigger/overview``) and, when they should be shown but cannot be,
    why. A local instance never asks. One hub call at a time; its answer, good or bad, is reused for
    ``CLOUD_TTL_S`` so a poll never waits on an offline hub again and again."""
    global _cloud_cache, _cloud_inflight
    from flow_sdk.cli.auth.hub_login import hub_auth_available  # noqa: PLC0415
    from flow_sdk.instance_settings.privacy_mode import is_local_mode  # noqa: PLC0415

    if is_local_mode():
        return [], None
    if not hub_auth_available():
        return [], CloudWarning("CLOUD_SIGNED_OUT", "Sign in to Flowpad to see the automations that run in the cloud.")
    if _cloud_cache and time.monotonic() - _cloud_cache[0] < CLOUD_TTL_S:
        return _cloud_cache[1]
    if _cloud_inflight is None or _cloud_inflight.done():
        _cloud_inflight = asyncio.ensure_future(_fetch_cloud())
    answer = await asyncio.shield(_cloud_inflight)
    _cloud_cache = (time.monotonic(), answer)
    return answer


async def overview_with_cloud(*, include_inactive: bool = False) -> CloudAnswer:
    """This machine's automations and the cloud's, by name; the warning says why the cloud's are missing."""
    local, (cloud, warning) = await asyncio.gather(overview(include_inactive=include_inactive), cloud_rows())
    rows = [*local, *cloud] if cloud else local
    return sorted(rows, key=lambda s: (s.name.casefold(), s.id)), warning
