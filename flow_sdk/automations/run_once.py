"""*Run once now* — one rule for every kind of automation.

A test run:
  * runs even when the automation is switched off (that is how someone checks a
    rule before turning it on);
  * never spends what a real fire spends — no counter bump, so a ``fire_once``
    rule stays unspent, no storm budget, no confirm query;
  * writes its history row with ``is_test=True`` and the rule's ``spec_hash``,
    which is what clears "Not tested yet";
  * returns at once: the work runs as a task and the person follows it on Runs.

Before this, each kind answered differently: a schedule test was a REAL fire
(counter bumped, ``is_test`` false, silently nothing when disabled), a file test
refused when disabled, and an event rule had no branch at all — it fell into
the hook path and failed with "Trigger has no filesystem path".
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.schema.data_spec.automation_spec import RunOnceStarted
from flow_sdk.schema.data_spec.trigger_types import TriggerType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.trigger import Trigger
    from flow_sdk.tags.envelope import FlowEvent

logger = logging.getLogger(__name__)

#: Test runs in flight — held so the loop cannot collect a task mid-run.
_inflight: set["asyncio.Task[Any]"] = set()


class RunOnceRefused(ValueError):
    """The rule cannot be run as configured — the message says what to fix."""


def _spawn(coro: Any, name: str) -> None:
    task = asyncio.get_running_loop().create_task(coro, name=name)
    _inflight.add(task)
    task.add_done_callback(_inflight.discard)


def sample_tag(pattern: str) -> str:
    """A concrete tag a pattern matches: each wildcard segment becomes ``test``."""
    return ".".join("test" if "*" in seg else seg for seg in pattern.split("."))


def test_event(trigger: "Trigger", event: Optional[dict[str, Any]] = None) -> "FlowEvent":
    """The envelope a test fires with: the one the person picked, else a sample.

    ``event`` is ``{tag, target?, data?}`` — a recent real event from the bus or a
    stored run's cause ("Run again with this event")."""
    from flow_sdk.tags.bus import make_tag_event  # noqa: PLC0415
    from flow_sdk.tags.envelope import target_of  # noqa: PLC0415

    if event and event.get("tag"):
        made = make_tag_event(str(event["tag"]), str(event.get("target") or target_of("trigger", trigger.id or "")),
                              dict(event.get("data") or {}))
        if event.get("scope"):
            made = made.model_copy(update={"ctx": made.ctx.model_copy(update={"scope": list(event["scope"])})})
        return made
    pattern = str(trigger.tag_pattern or "")
    if not pattern:
        raise RunOnceRefused("This automation has no event to listen for yet. Pick one under When.")
    target = str(trigger.tag_target or "")
    if not target or "*" in target:
        target = target_of("trigger", trigger.id or "")
    return make_tag_event(sample_tag(pattern), target, {"test": True})


async def subject_event(trigger: "Trigger", subject_id: str) -> dict[str, Any]:
    """The envelope a test fires with for one thing the rule decides about (a message): the target,
    data and scope its real event carried — the subject's to say — under the rule's own sample tag
    (its pattern may name one provider). The gate and the wizard then see the real thing."""
    from flow_sdk.automations.decision_subjects import for_trigger  # noqa: PLC0415

    subject = for_trigger(trigger)
    try:
        if subject is None:
            raise LookupError
        parts = await subject.test_event(subject_id)
    except LookupError:
        raise RunOnceRefused("That is not something this rule can run on.") from None
    return {**parts, "tag": sample_tag(str(trigger.tag_pattern or ""))}


async def run_once(trigger: "Trigger", event: Optional[dict[str, Any]] = None, *,
                   message_id: Optional[str] = None) -> RunOnceStarted:
    """Start one test run of ``trigger``. Raises ``RunOnceRefused`` with a fix-it message.
    ``message_id`` runs a stream inbox rule on that message (its real envelope)."""
    from flow_sdk.builtin.trigger_on_tag import emit_trigger_fired  # noqa: PLC0415

    kind = TriggerType(str(trigger.trigger_type))
    tid = trigger.id or ""
    if message_id and kind == TriggerType.TAG:
        event = await subject_event(trigger, message_id)

    if kind == TriggerType.TAG:
        from flow_sdk.builtin.tag_triggers import run_tag_test  # noqa: PLC0415

        envelope = test_event(trigger, event)
        event_id = emit_trigger_fired(
            tid, str(trigger.trigger_type), trigger.name or tid,
            counter=trigger.counter,
            action_types=[str(a.action_type) for a in trigger.actions],
            detail={"cause_tag": envelope.tag, "cause_target": envelope.target},
            project_id=trigger.project_id,
            cause=envelope,
            is_test=True,
        )
        _spawn(run_tag_test(trigger, envelope, event_id), f"trigger-test:{tid}")
        return RunOnceStarted(trigger_id=tid, event_id=event_id,
                              detail={"tag": envelope.tag, "target": envelope.target})

    if kind == TriggerType.FSOP:
        if not trigger.watch_path:
            raise RunOnceRefused("This automation watches no file or folder yet. Pick one under When.")
        from pathlib import Path  # noqa: PLC0415

        from flow_sdk.builtin.change_event import ChangeEvent  # noqa: PLC0415
        from flow_sdk.server.fsop_watcher import _fire  # noqa: PLC0415

        _spawn(_fire(trigger, [ChangeEvent(path=Path(trigger.watch_path), change_type="test")], is_test=True),
               f"trigger-test:{tid}")
        return RunOnceStarted(trigger_id=tid, detail={"path": trigger.watch_path})

    if kind == TriggerType.SCHEDULE:
        from flow_sdk.builtin.trigger import run_schedule_fire  # noqa: PLC0415

        event_id = emit_trigger_fired(
            tid, str(trigger.trigger_type), trigger.name or tid,
            counter=trigger.counter,
            action_types=[str(a.action_type) for a in trigger.actions],
            detail={"expr": trigger.expr, "sched_trigger_type": trigger.sched_trigger_type or "cron"},
            project_id=trigger.project_id,
            is_test=True,
        )
        _spawn(run_schedule_fire(trigger, event_id, is_test=True), f"trigger-test:{tid}")
        return RunOnceStarted(trigger_id=tid, event_id=event_id)

    # HOOK: a rule folder runs its own trigger.py against a sample prompt event.
    return await _run_hook_rule_once(trigger)


async def _run_hook_rule_once(trigger: "Trigger") -> RunOnceStarted:
    """A hook rule's test is quick and local: run its rule against a sample event."""
    from pathlib import Path  # noqa: PLC0415

    from flow_sdk.automations.fingerprint import spec_hash  # noqa: PLC0415
    from flow_sdk.fs_store.operations.trigger_log import append_entry  # noqa: PLC0415

    if not trigger.path:
        raise RunOnceRefused("This agent rule has no rule folder, so there is nothing to run.")
    record_file = Path(trigger.path) / "record.json"
    if not record_file.exists():
        raise RunOnceRefused(f"The rule folder has no record.json ({trigger.path}).")
    from flow_sdk.rules.activation_rule import ActivationRule  # noqa: PLC0415

    rule = ActivationRule.load_record(record_file)
    result = rule.run({"hookEvent": "UserPromptSubmit", "hook_event_name": "UserPromptSubmit",
                       "prompt": "", "cwd": ""}, [])
    append_entry(rule.name, {
        "hook_event": "UserPromptSubmit",
        "trigger": result.trigger,
        "reason": result.reason or "",
        "is_test": True,
        "rule_name": rule.name,
        "trigger_id": trigger.id,
        "trigger_type": str(trigger.trigger_type),
        "actions": [a.type for a in result.actions] if result.actions else [],
        "spec_hash": spec_hash(trigger),
    })
    return RunOnceStarted(trigger_id=trigger.id or "", background=False, detail=result.to_dict())
