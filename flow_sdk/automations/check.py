"""*Check* — a dry run: would this automation run, and what would it do.

No side effects: nothing fires, nothing is written, no counter moves. It reads
the rule (saved, or still being edited in the builder) and answers findings in
words — the trigger part is valid, the picked event matches it field by field,
nothing blocks it (switched off, a once-only rule already spent, a copy from
another install), and every step can run (the agent exists, the callback is
registered, the script is there).
"""

from __future__ import annotations

import os
from typing import Any, Optional

from flow_sdk.schema.data_spec.automation_spec import AutomationCheck, CheckFinding

#: Fields the builder may send for an unsaved automation — the Trigger fields a
#: person sets. Anything else in the body is ignored, never trusted onto a row.
SPEC_FIELDS: frozenset[str] = frozenset({
    "name", "description", "trigger_type", "enabled", "project_id",
    "expr", "sched_trigger_type", "timezone",
    "tag_pattern", "tag_target", "tag_scope", "max_fires_per_minute", "fire_once", "confirm",
    "watch_path", "recursive", "watch_glob", "ignore_patterns", "respect_gitignore",
    "hook_events", "mask", "actions", "instruction", "workdir",
})


def trigger_from_spec(fields: dict[str, Any]) -> Any:
    """An UNSAVED Trigger from builder fields — validated by the entity itself."""
    from flow_sdk.builtin.trigger import Trigger  # noqa: PLC0415

    picked = {k: v for k, v in (fields or {}).items() if k in SPEC_FIELDS}
    picked.setdefault("name", "Untitled automation")
    return Trigger(**picked)


def _when_findings(trigger: Any) -> tuple[list[CheckFinding], list[str]]:
    from flow_sdk.automations.describe import kind_of  # noqa: PLC0415

    kind = kind_of(trigger)
    findings: list[CheckFinding] = []
    next_runs: list[str] = []
    if kind == "schedule":
        from flow_sdk.automations.schedule import next_fire_times  # noqa: PLC0415

        try:
            times = next_fire_times(trigger.expr or "", trigger.sched_trigger_type, trigger.timezone, 5)
        except (ValueError, KeyError, TypeError) as exc:
            findings.append(CheckFinding(area="when", ok=False, message=f"The schedule can't be read: {exc}"))
        else:
            next_runs = [t.isoformat() for t in times]
            findings.append(CheckFinding(
                area="when", ok=bool(times),
                message="It will run next at the times shown." if times else "This schedule has no future run.",
            ))
    elif kind == "event":
        from flow_sdk.tags.grammar import tag_pattern_problem  # noqa: PLC0415

        problem = tag_pattern_problem(trigger.tag_pattern)
        findings.append(CheckFinding(area="when", ok=problem is None,
                                     message=problem or "The event to listen for is valid."))
    elif kind == "file":
        path = str(trigger.watch_path or "")
        if not path:
            findings.append(CheckFinding(area="when", ok=False, message="Pick a file or folder to watch."))
        elif not os.path.exists(path):
            findings.append(CheckFinding(area="when", ok=False, message=f"{path} does not exist."))
        else:
            findings.append(CheckFinding(area="when", ok=True, message=f"{path} is there to watch."))
    else:
        events = list(trigger.hook_events or [])
        findings.append(CheckFinding(area="when", ok=bool(events) or bool(trigger.path),
                                     message="Listening for: " + ", ".join(events) if events
                                     else "Pick which agent activity to react to."))
    return findings, next_runs


def _event_findings(trigger: Any, event: dict[str, Any]) -> tuple[list[CheckFinding], bool]:
    from flow_sdk.tags.bus import explain_subscription_match  # noqa: PLC0415

    tag = str(event.get("tag") or "")
    target = str(event.get("target") or "")
    scope = list(event.get("scope") or [])
    parts = explain_subscription_match(str(trigger.tag_pattern or ""), tag, target,
                                       target_filter=trigger.tag_target or None,
                                       scope_filter=list(trigger.tag_scope or []) or None, scope=scope)
    findings = [CheckFinding(area="event", ok=parts["tag"],
                             message=f"{tag} matches {trigger.tag_pattern}." if parts["tag"]
                             else f"{tag} does not match {trigger.tag_pattern}.")]
    if trigger.tag_target:
        findings.append(CheckFinding(area="event", ok=parts["target"],
                                     message=f"{target} is the subject it watches." if parts["target"]
                                     else f"{target} is not {trigger.tag_target}."))
    if trigger.tag_scope:
        findings.append(CheckFinding(area="event", ok=parts["scope"],
                                     message="The event is in the scope it watches." if parts["scope"]
                                     else "The event is outside the scope it watches."))
    return findings, all(parts.values())


def _state_findings(trigger: Any) -> list[CheckFinding]:
    from flow_sdk.builtin.trigger_arming import is_foreign_copy  # noqa: PLC0415

    out: list[CheckFinding] = []
    if not trigger.enabled:
        out.append(CheckFinding(area="state", ok=False,
                                message="It is switched off, so it will not run until you turn it on."))
    if trigger.fire_once and (trigger.counter or 0) >= 1:
        out.append(CheckFinding(area="state", ok=False,
                                message="It only runs once, and it already ran."))
    if is_foreign_copy(trigger.asset_ref):
        out.append(CheckFinding(area="state", ok=False,
                                message="This is a copy from another Flowpad install; it never runs here."))
    return out


async def check(trigger: Any, event: Optional[dict[str, Any]] = None) -> AutomationCheck:
    """Findings for ``trigger`` (saved or not), optionally against one event."""
    from flow_sdk.automations.describe import describe_then, describe_when, kind_of  # noqa: PLC0415

    findings, next_runs = _when_findings(trigger)
    would_fire: Optional[bool] = None
    if event and kind_of(trigger) == "event":
        event_findings, would_fire = _event_findings(trigger, event)
        findings += event_findings
    findings += _state_findings(trigger)

    then = await describe_then(trigger)
    for part in then:
        if part.kind == "nothing":
            findings.append(CheckFinding(area="then", ok=False, message="It does nothing yet. Add what it should do."))
        elif part.problem:
            findings.append(CheckFinding(area="then", ok=False, message=part.problem))
        elif part.kind in ("run_agent", "notify", "open_wizard") and part.target and not part.target_name:
            findings.append(CheckFinding(area="then", ok=False,
                                         message=f"{part.target} was not found. Pick it again."))
        else:
            findings.append(CheckFinding(area="then", ok=True, message=f"Will {part.text[0].lower()}{part.text[1:]}."))

    return AutomationCheck(
        ok=all(f.ok for f in findings),
        would_fire=would_fire,
        findings=findings,
        when=describe_when(trigger),
        then=then,
        next_runs=next_runs,
    )
