"""Domain operations called by the compiled wizard, one effect per call."""
from __future__ import annotations

from datetime import datetime, timezone

from flow_sdk.automations.execution import AutomationMode
from flow_sdk.schema.data_spec.automation_execution_spec import (
    AutomationActionResult,
    AutomationGateResult,
    PreparedAutomation,
)
from flow_sdk.schema.data_spec.returned_value_spec import DecisionVerdict, ExitCode, ReturnedValue
from flow_sdk.schema.data_spec.trigger_types import TriggerType


async def confirm(input: PreparedAutomation, *, context) -> ReturnedValue:
    from flow_sdk.builtin.tag_triggers import _confirmed
    trigger = context.trigger
    if not await _confirmed(trigger):
        detail = f"confirm query on {(trigger.confirm or {}).get('type')} matched no rows"
        return AutomationGateResult.not_applicable(detail, reason_code="confirm_failed")
    return ReturnedValue.satisfied(value=input, ran=False)


async def prepare(input: PreparedAutomation, *, context) -> ReturnedValue:
    from flow_sdk.automations.decision_subjects import NotCaught, for_target, for_trigger
    trigger = context.trigger
    if not getattr(trigger, "gate", None):
        return ReturnedValue.satisfied(value=input, ran=False)
    subject = for_target(context.event.target) if context.event is not None else for_trigger(trigger)
    if subject is None:
        return _declined(context, "nothing knows what this rule decides about")
    try:
        if context.preview_state is not None:
            state = context.preview_state
        elif context.event is not None:
            state = await subject.of(context.event.target)
        elif context.preview_message_id:
            state = await subject.by_id(context.preview_message_id)
        else:
            state = subject.from_text(context.preview_text or "")
    except LookupError as exc:
        verdict = DecisionVerdict.not_found(str(exc) or "no such thing")
        return AutomationGateResult.not_found(verdict.detail, verdict=verdict)
    except NotCaught as exc:
        if context.mode is AutomationMode.PREVIEW:
            verdict = DecisionVerdict.not_yet(exc.reason, ran=False, reason=exc.reason)
            return AutomationGateResult.not_applicable(exc.reason, verdict=verdict)
        return _declined(context, exc.reason)
    return ReturnedValue.satisfied(value=input.model_copy(update={
        "state": state, "scope_key": subject.scope_key,
        "subject_target": str(context.event.target) if context.event is not None else subject.target_type + ":",
    }), ran=False)


async def decide(input: PreparedAutomation, *, context) -> ReturnedValue:
    from pydantic import ValidationError

    from flow_sdk.core.compute_op.decision import decide_op
    try:
        op = context.trigger.gate_op
    except ValidationError:
        return _declined(context, "this rule's if cannot be read")
    if op is None:
        return _declined(context, "nothing knows what this rule decides about")
    verdict = await decide_op(op, input.state)
    if context.mode is not AutomationMode.PREVIEW:
        _decision_events(context, verdict)
    return AutomationGateResult(
        exit_code=verdict.exit_code, detail=verdict.detail, ran=verdict.ran,
        verdict=verdict, value=input.model_copy(update={"verdict": verdict}) if verdict.met else None,
        value_present=verdict.met,
        reason_code="decision_unavailable" if verdict.unavailable else "decision_no" if not verdict.met else "",
    )


def _declined(context, detail):
    if context.mode is not AutomationMode.PREVIEW:
        from flow_sdk.builtin.trigger_on_tag import emit_trigger_decided
        trigger = context.trigger
        emit_trigger_decided(trigger.id or "", str(trigger.trigger_type), trigger.name or trigger.id or "",
                             outcome="no", reason=detail, project_id=trigger.project_id, cause=context.event)
    return AutomationGateResult.not_applicable(detail, reason_code="decision_no")


def _decision_events(context, verdict):
    from flow_sdk.builtin.trigger_on_tag import emit_trigger_decided, emit_trigger_failed
    trigger = context.trigger
    emit_trigger_decided(trigger.id or "", str(trigger.trigger_type), trigger.name or trigger.id or "",
                         outcome="caught" if verdict.met else "unavailable" if verdict.unavailable else "no",
                         confidence=verdict.confidence, reason=verdict.reason or verdict.detail,
                         project_id=trigger.project_id, cause=context.event)
    if verdict.unavailable:
        emit_trigger_failed(trigger.id or "", str(trigger.trigger_type), trigger.name or trigger.id or "",
                            stage="decision", error=verdict.detail, project_id=trigger.project_id)


async def accept(input: PreparedAutomation, *, context) -> ReturnedValue:
    from flow_sdk.automations import compat
    from flow_sdk.builtin.trigger_on_tag import emit_trigger_fired
    trigger = context.trigger
    kind = TriggerType(str(trigger.trigger_type))
    event_id = input.event_id
    if context.mode is AutomationMode.REAL:
        if kind is TriggerType.TAG:
            trigger.counter += 1
            trigger.last_run = datetime.now(timezone.utc)
            await trigger.update()
        elif kind is TriggerType.SCHEDULE:
            await compat.accept_schedule(trigger)
        elif kind is TriggerType.FSOP:
            await compat.accept_file(trigger, context.changes)
        elif kind is TriggerType.HOOK:
            await compat.accept_hook(trigger)
        if kind in (TriggerType.TAG, TriggerType.SCHEDULE):
            detail = ({"cause_tag": context.event.tag, "cause_target": context.event.target}
                      if kind is TriggerType.TAG else
                      {"expr": trigger.expr, "sched_trigger_type": trigger.sched_trigger_type or "cron"})
            event_id = emit_trigger_fired(trigger.id or "", str(trigger.trigger_type), trigger.name or trigger.id or "",
                                         counter=trigger.counter, action_types=[str(a.action_type) for a in trigger.actions],
                                         detail=detail, project_id=trigger.project_id, cause=context.event)
    accepted = input.model_copy(update={"event_id": event_id})
    if kind is TriggerType.TAG:
        from flow_sdk.builtin.tag_triggers import record_tag_start
        record_tag_start(trigger, context.event, accepted, is_test=context.mode is AutomationMode.TEST)
    return ReturnedValue.satisfied(value=accepted)


async def activate(input: PreparedAutomation, *, context) -> ReturnedValue:
    from flow_sdk.builtin.trigger import activate_flows_for_trigger
    trigger = context.trigger
    error = await activate_flows_for_trigger(trigger.id or "", trigger.name or trigger.id or "",
                                             envelope=context.event, trigger=trigger)
    return ReturnedValue.not_yet(error) if error else ReturnedValue.satisfied()


async def then(input: PreparedAutomation, *, context) -> ReturnedValue:
    from flow_sdk.automations.decision_subjects import for_target
    from flow_sdk.automations.then import EVENT_KEY, LAUNCH_KEY, run_then
    trigger = context.trigger
    inputs = dict(input.inputs)
    if context.event is not None:
        inputs[EVENT_KEY] = context.event.model_dump(mode="json")
    if input.state is not None:
        subject = for_target(input.subject_target)
        inputs[input.scope_key] = input.state
        if subject is not None:
            launch = subject.launch_context(input.state)
            verdict = input.verdict
            inputs[LAUNCH_KEY] = launch.model_copy(update={"context_data": {
                **launch.context_data, "automation": {
                    "trigger_id": trigger.id or "", "run_id": input.run_id, "name": trigger.name,
                    "reason": verdict.reason or verdict.detail if verdict is not None else "",
                    "confidence": verdict.confidence if verdict is not None else 0.0,
                    "subject_id": subject.subject_id(input.state),
                },
            }})
    try:
        answer = await run_then(trigger, inputs=inputs, scope_key=input.scope_key, context=context)
    except Exception as exc:
        answer = ReturnedValue.not_yet(f"then: {exc}")
    from flow_sdk.builtin.trigger import _failure_of
    error = _failure_of(answer)
    _emit_action_failure(trigger, error, "then")
    # This compatibility operation runs the nested sequence; its step evidence stays intact.
    # It promises no typed application value of its own.
    return answer.model_copy(update={"value": None, "value_present": False})


async def action(input: int, *, context) -> ReturnedValue:
    from flow_sdk.builtin.hook_models import get_action_handler
    from flow_sdk.builtin.trigger import _failure_of
    trigger = context.trigger
    selected = trigger.action if context.hook else trigger.actions[input]
    try:
        handler = get_action_handler(selected.action_type)
        if handler is None:
            answer = ReturnedValue.not_yet(f"No handler for action {selected.action_type}", ran=False)
        else:
            result = await handler.execute(trigger, action=selected, changes=None if context.hook else context.changes)
            if context.hook:
                await trigger.update()
            answer = result if isinstance(result, ReturnedValue) else ReturnedValue.satisfied()
        error = _failure_of(answer)
    except Exception as exc:
        answer = ReturnedValue.not_yet(str(exc))
        error = str(exc)
    _emit_action_failure(trigger, error, str(selected.action_type))
    if answer.executor:
        context.attach_executor(answer.executor)
    from flow_sdk.schema.data_spec.returned_value_spec import WizardResult
    executor = answer.first_executor() if isinstance(answer, WizardResult) else answer.executor
    fields = {name: getattr(answer, name) for name in ReturnedValue.model_fields}
    fields.update(value=None, value_present=False, executor=executor)
    if answer.busy or answer.exit_code is ExitCode.REFUSED:
        fields.update(exit_code=ExitCode.OK, ran=False, busy=False)
    return AutomationActionResult(**fields, answer=answer, action_type=str(selected.action_type))


def _emit_action_failure(trigger, error: str, action_type: str) -> None:
    if not error:
        return
    from flow_sdk.builtin.trigger_on_tag import emit_trigger_failed

    emit_trigger_failed(trigger.id or "", str(trigger.trigger_type), trigger.name or trigger.id or "",
                        stage="action", error=error, action_type=action_type, project_id=trigger.project_id)


async def instruction(input: PreparedAutomation, *, context) -> ReturnedValue:
    from flow_sdk.automations.compat import run_instruction
    try:
        answer = await run_instruction(context.trigger)
    except Exception as exc:
        return ReturnedValue.not_yet(f"Could not start the agent: {exc}")
    if answer.executor:
        context.attach_executor(answer.executor)
    return answer


async def noop(input: PreparedAutomation, *, context) -> ReturnedValue:
    return ReturnedValue.satisfied(ran=False)
