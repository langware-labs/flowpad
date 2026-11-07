"""One automation invocation: compile its declaration, then call the wizard.

The context holds immutable invocation capabilities, not intermediate results.
Prepared subject/decision values travel between the ordinary ComputeOp calls.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core.compute_op.context import CallContext
from flow_sdk.core.wizard.runner import run_wizard
from flow_sdk.schema.data_spec.automation_execution_spec import PreparedAutomation
from flow_sdk.schema.data_spec.returned_value_spec import DecisionVerdict, ExitCode, ReturnedValue, WizardResult

logger = logging.getLogger(__name__)


class AutomationMode(StrEnum):
    REAL = "real"
    TEST = "test"
    PREVIEW = "preview"
    ACTIONS = "actions"


@dataclass
class AutomationCallContext(CallContext):
    trigger: Any = None
    event: Any = None
    changes: Any = None
    mode: AutomationMode = AutomationMode.REAL
    preview_state: Any = None
    preview_text: str | None = None
    preview_message_id: str | None = None
    hook: bool = False


@dataclass
class AutomationExecution:
    result: WizardResult
    run_id: str
    event_id: str | None
    duration_ms: int
    gate: Any = None

    @property
    def accepted(self) -> bool:
        answer = self.result.steps.get("accept")
        return answer is not None and answer.exit_code is ExitCode.OK and answer.has_value

    @property
    def reason_code(self) -> str | None:
        if self.accepted:
            return None
        if self.result.busy:
            return "busy"
        if self.result.exit_code is ExitCode.REFUSED:
            return "refused"
        if self.result.exit_code is ExitCode.NOT_APPLICABLE:
            return next((getattr(a, "reason_code", "") for a in self.result.steps.values()
                         if getattr(a, "reason_code", "")), "not_applicable")
        return None

    @property
    def process_id(self) -> str | None:
        instruction = self.result.steps.get("instruction")
        executor = getattr(instruction, "executor", None) or self.result.first_executor()
        return executor.removeprefix("agentic_process-") if executor else None

    @property
    def error(self) -> str | None:
        from flow_sdk.builtin.trigger import _failure_of
        if self.result.busy:
            return self.result.detail or "The automation is already running."
        if self.result.exit_code is ExitCode.NOT_APPLICABLE:
            return None
        errors = []
        for answer in self.result.steps.values():
            error = _failure_of(answer)
            kind = getattr(answer, "action_type", "")
            if error:
                errors.append(f"{kind}: {error}" if kind else error)
        return "; ".join(errors) or _failure_of(self.result) or None

    @property
    def wizard(self) -> dict:
        nested = self.result.steps.get("then")
        if isinstance(nested, WizardResult):
            # The existing automation screen addresses the authored steps directly.
            return {**nested.outline(), "exit_code": int(self.result.exit_code), "detail": self.result.detail,
                    "invocation_id": self.result.invocation_id,
                    "automation": self.result.outline()}
        return {**self.result.outline(), "invocation_id": self.result.invocation_id}


async def run_automation(trigger: Any, *, mode: AutomationMode | str = AutomationMode.REAL,
                         event=None, changes=None, inputs=None, scope_key: str = "", run_id=None,
                         event_id=None, include_graph: bool = True, include_instruction: bool = False,
                         hook: bool = False, preview_state=None, preview_text=None, preview_message_id=None) -> AutomationExecution:
    from flow_sdk.automations.compiler import compile_automation
    from flow_sdk.automations.then import _workdir
    from flow_sdk.core.wizard.state import target_segment

    mode = AutomationMode(mode)
    run_id = run_id or str(mint_uuid())
    prepared = PreparedAutomation(run_id=run_id, event_id=event_id, inputs=dict(inputs or {}),
                                  scope_key=scope_key)
    started = time.monotonic()
    partial = WizardResult.not_yet("not started", ran=False, invocation_id=run_id, value_present=False)
    spec = None

    async def progress(answer):
        nonlocal partial
        partial = answer

    try:
        spec, resolve = compile_automation(trigger, mode=mode, include_graph=include_graph,
                                           include_instruction=include_instruction, hook=hook)
        folder = await _workdir(trigger) or Path.cwd()
        context = AutomationCallContext(asset_folder=folder, workdir=folder,
                                        invocation_id=run_id, project=getattr(trigger, "project_id", None),
                                        trigger=trigger, event=event, changes=list(changes or []), mode=mode,
                                        preview_state=preview_state, preview_text=preview_text,
                                        preview_message_id=preview_message_id, hook=hook)
        # Preserve the per-trigger activity slot; previews are independent read-only calls.
        slot = run_id if mode is AutomationMode.PREVIEW else str(getattr(trigger, "id", "") or spec.name)
        result = await run_wizard(spec, trusted=True, workdir=folder, input=prepared, context=context,
                                  resolve_op=resolve, activity_path=f"automation/{target_segment(slot)}",
                                  subject_entity=str(getattr(trigger, "typeid", "") or "") or None,
                                  on_step=progress)
    except Exception as exc:
        logger.exception("Automation %s failed", getattr(trigger, "name", ""))
        reached = dict(partial.steps)
        step = next((s.id for s in spec.steps if s.id not in reached), "execution") if spec is not None else "definition"
        reached[step] = ReturnedValue.not_yet(str(exc), invocation_id=run_id, value_present=False,
                                               ran=spec is not None)
        result = WizardResult.not_yet(str(exc), steps=reached, invocation_id=run_id, value_present=False,
                                     ran=any(answer.ran for answer in reached.values()))
    if result.invocation_id is None:
        result = result.model_copy(update={"invocation_id": run_id})
    accepted = result.steps.get("accept")
    if accepted is not None and isinstance(accepted.value, PreparedAutomation):
        event_id = accepted.value.event_id
    gate = _gate_of(result, trigger, event)
    return AutomationExecution(result, run_id, event_id, int((time.monotonic() - started) * 1000), gate)


def _gate_of(result, trigger, event):
    if not getattr(trigger, "gate", None):
        return None
    from flow_sdk.automations.decision_subjects import for_target, for_trigger
    from flow_sdk.builtin.tag_triggers import GateOutcome
    prepared = result.steps.get("prepare")
    value = prepared.value if prepared is not None else None
    subject = for_target(event.target) if event is not None else for_trigger(trigger)
    answer = result.steps.get("decide") or prepared
    verdict = getattr(answer, "verdict", None)
    return GateOutcome(verdict, value.state if isinstance(value, PreparedAutomation) else None,
                       subject, declined=answer.detail if answer is not None and verdict is None else "")


async def run_decision(trigger, *, state=None, text=None, message_id=None) -> DecisionVerdict:
    execution = await run_automation(trigger, mode=AutomationMode.PREVIEW, preview_state=state,
                                      preview_text=text, preview_message_id=message_id)
    if execution.gate is not None and execution.gate.verdict is not None:
        return execution.gate.verdict
    if execution.result.exit_code in (ExitCode.OK, ExitCode.NOT_APPLICABLE):
        return DecisionVerdict.not_applicable(execution.result.detail or "this rule has no if")
    return DecisionVerdict.not_yet(execution.result.detail, ran=False)
