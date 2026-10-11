"""A rule as a sentence: When … → Then ….

``describe_when`` and ``describe_then`` read a ``Trigger`` (saved or not) into the
structured parts every surface renders. Names are resolved here — "Run LLM
setup", not "callback builtin_run_llm_setup" — so no surface has to know what a
callback name or a TypeId means.
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import Any, Optional

from flow_sdk.schema.data_spec.automation_spec import (
    AutomationKind,
    EventWhen,
    FileWhen,
    HookWhen,
    ThenPart,
    WhenPart,
)
from flow_sdk.schema.data_spec.trigger_action import ActionType
from flow_sdk.schema.data_spec.trigger_types import TriggerType

logger = logging.getLogger(__name__)

#: Trigger kinds in the words the screen uses.
KIND_OF: dict[str, AutomationKind] = {
    TriggerType.SCHEDULE.value: "schedule",
    TriggerType.TAG.value: "event",
    TriggerType.FSOP.value: "file",
    TriggerType.HOOK.value: "agent_hook",
}

#: Callbacks that open a wizard; their target is the wizard.
WIZARD_CALLBACKS = frozenset({"builtin_run_wizard", "builtin_run_llm_setup"})


def kind_of(trigger: Any) -> AutomationKind:
    return KIND_OF.get(str(trigger.trigger_type), "agent_hook")


@lru_cache(maxsize=1)
def event_catalog() -> dict[str, tuple[str, str]]:
    """tag name → (title, description), from the shipped tag vocabulary (fixed per process)."""
    from flow_sdk.builtin.tag import SYSTEM_TAG_SEED  # noqa: PLC0415

    return {name: (title, description) for name, title, description in SYSTEM_TAG_SEED}


def describe_event(pattern: str, target: Optional[str] = None,
                   catalog: Optional[dict[str, tuple[str, str]]] = None) -> EventWhen:
    catalog = catalog if catalog is not None else event_catalog()
    title, description = catalog.get(pattern, ("", ""))
    if not title and pattern.endswith(".*"):
        family = catalog.get(pattern[:-2])
        if family:
            title, description = f"Any {family[0].lower()}", family[1]
    return EventWhen(pattern=pattern, title=title, description=description, target=target or None)


def describe_when(trigger: Any, catalog: Optional[dict[str, tuple[str, str]]] = None) -> WhenPart:
    from flow_sdk.automations.decision_subjects import for_pattern  # noqa: PLC0415
    from flow_sdk.automations.schedule import read_schedule, schedule_text  # noqa: PLC0415

    kind = kind_of(trigger)
    if kind == "schedule":
        schedule = read_schedule(trigger.expr or "", trigger.sched_trigger_type, trigger.timezone)
        return WhenPart(kind=kind, text=schedule_text(schedule), schedule=schedule)
    if kind == "event":
        event = describe_event(str(trigger.tag_pattern or ""), trigger.tag_target, catalog)
        subject = for_pattern(event.pattern)
        if subject is not None and subject.when_text:
            return WhenPart(kind=kind, text=subject.when_text, event=event)
        label = event.title or event.pattern or "an event"
        return WhenPart(kind=kind, text=f"When {label} happens", event=event)
    if kind == "file":
        path = str(trigger.watch_path or "")
        file = FileWhen(path=path, glob=trigger.watch_glob or None, recursive=bool(trigger.recursive),
                        is_folder=bool(path) and os.path.isdir(path))
        what = f"{file.glob} in {file.path}" if file.glob else file.path or "a file"
        return WhenPart(kind=kind, text=f"When {what} changes", file=file)
    hook = HookWhen(events=list(trigger.hook_events or []))
    events = ", ".join(hook.events) or "an agent event"
    return WhenPart(kind=kind, text=f"When an agent reports {events}", hook=hook)


class _Names:
    """Resolves TypeIds to display names once per request."""

    def __init__(self) -> None:
        self._cache: dict[str, Optional[str]] = {}

    async def name(self, typeid: Optional[str]) -> Optional[str]:
        if not typeid:
            return None
        if typeid in self._cache:
            return self._cache[typeid]
        found: Optional[str] = None
        try:
            from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

            row = await Entity.get_by_typeid(typeid)  # resolves `type-<id>` and `type-@uname`
            found = (getattr(row, "name", None) or getattr(row, "title", None)) if row else None
        except Exception:  # noqa: BLE001 — a name is display sugar; never fail the list over it
            logger.debug("could not resolve %s", typeid, exc_info=True)
        self._cache[typeid] = found
        return found


async def _describe_then_wizard(spec: Any, *, names: _Names, parent_type_id: str = "") -> list[ThenPart]:
    """A ``then`` wizard in words: the sugar's one agent or script, else the steps."""
    if spec.run_agent is not None:
        target = spec.run_agent.agent or parent_type_id or None
        who = await names.name(target)
        return [ThenPart(kind="run_agent", text=f"Run {who or 'an agent'}", target=target, target_name=who,
                         prompt=spec.run_agent.prompt)]
    if spec.run_script is not None:
        return [ThenPart(kind="run_script", text=f"Run {spec.run_script}", target_name=spec.run_script)]
    if spec.ref:
        return [ThenPart(kind="workflow", text=f"Run the wizard {spec.ref}", target_name=spec.ref)]
    return [ThenPart(kind="workflow", text=f"Run {len(spec.steps)} steps", detail=", ".join(s.id for s in spec.steps))]


async def describe_then(trigger: Any, *, names: Optional[_Names] = None,
                        workflows: Optional[list[str]] = None) -> list[ThenPart]:
    """What the rule does, one part per action — plus the workflows it starts."""
    from flow_sdk.automations.then import then_of  # noqa: PLC0415

    names = names or _Names()
    then = then_of(trigger)
    if then is not None:
        parts = await _describe_then_wizard(then, names=names, parent_type_id=str(trigger.parent_type_id or ""))
    else:
        parts = await _describe_actions(trigger, names)
    for name in workflows or []:
        parts.append(ThenPart(kind="workflow", text=f"Start workflow {name}", target_name=name))
    if not parts:
        parts.append(ThenPart(kind="nothing", text="Do nothing yet"))
    return parts


async def _describe_actions(trigger: Any, names: _Names) -> list[ThenPart]:
    """One part per action, and the bare ``instruction`` a rule with no action carries."""
    from flow_sdk.builtin import trigger_callbacks  # noqa: PLC0415

    parts: list[ThenPart] = []
    for action in trigger.actions or []:
        atype = str(action.action_type)
        target = action.target_type_id or None
        if atype == ActionType.RUN_AGENT.value:
            who = await names.name(target)
            parts.append(ThenPart(kind="run_agent", text=f"Run {who or 'an agent'}",
                                  target=target, target_name=who, prompt=action.prompt))
        elif atype == ActionType.CALLBACK.value:
            cb = action.callback_name or ""
            if cb in WIZARD_CALLBACKS:
                wizard_id = target or (trigger.parent_type_id if str(trigger.parent_type_id or "").startswith("wizard-") else None)
                who = await names.name(wizard_id)
                parts.append(ThenPart(kind="open_wizard", text=f"Open {who or 'a setup wizard'}",
                                      target=wizard_id, target_name=who))
            else:
                problem = None if trigger_callbacks.get(cb) else f"Nothing is registered under the name {cb!r}."
                label = cb.removeprefix("builtin_").replace("_", " ") or "a built-in step"
                parts.append(ThenPart(kind="builtin_step", text=f"Run {label}", target_name=label,
                                      detail=trigger_callbacks.meaning(cb), problem=problem))
        elif atype == ActionType.RUN_SCRIPT.value:
            script = action.script_path or action.script_filename or ""
            parts.append(ThenPart(kind="run_script", text=f"Run script {script.rsplit('/', 1)[-1] or ''}".strip(),
                                  target_name=script or None,
                                  problem=None if script else "No script is set."))
        elif atype == ActionType.NOTIFY_ENTITY.value:
            who = await names.name(target)
            parts.append(ThenPart(kind="notify", text=f"Notify {who or 'the linked item'}", target=target, target_name=who))
    if trigger.instruction:
        parts.append(ThenPart(kind="run_agent", text="Run an agent", prompt=trigger.instruction))
    return parts
