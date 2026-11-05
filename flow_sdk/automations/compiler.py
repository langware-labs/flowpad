"""Pure translation of compatible trigger forms into ordinary wizard calls."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from flow_sdk.automations.execution import AutomationMode
from flow_sdk.core.wizard.runner import Resolved
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from flow_sdk.schema.data_spec.trigger_types import TriggerType
from flow_sdk.schema.data_spec.wizard_spec import ON_FAIL_ABORT, ON_FAIL_CONTINUE, WizardSpec, WizardStepSpec

_ASSETS = Path(__file__).resolve().parents[1] / "system_projects/flowpad_assistant/agentic-assets/compute_op"


@lru_cache(maxsize=None)
def _operation(name: str) -> Resolved:
    folder = _ASSETS / f"automation-{name}"
    spec = ComputeOpSpec.model_validate(json.loads((folder / "compute_op.json").read_text()))
    return Resolved(spec, trusted=True, asset_folder=folder)


async def _resolve_operation(ref: str) -> Resolved:
    return _operation(ref.removeprefix("automation-"))


def compile_automation(trigger, *, mode: AutomationMode, include_graph=True,
                       include_instruction=False, hook=False):
    from flow_sdk.automations.then import as_wizard, then_of
    declared = then_of(trigger)
    if declared is not None:
        as_wizard(declared, name=trigger.name or "automation")  # validate without importing executable assets
    has_instruction = include_instruction and bool(getattr(trigger, "instruction", None))
    steps = []
    source = "$input"

    def append(name, *, returns=False, **kwargs):
        nonlocal source
        rules = [{"when": {"exit_code": int(ExitCode.NOT_APPLICABLE)}, "return": "result"}] if returns else []
        if name == "decide":
            rules.append({"when": {"exit_code": int(ExitCode.NOT_YET), "verdict.met": False, "verdict.unavailable": None},
                          "return": "not_applicable"})
        steps.append(WizardStepSpec(id=name, ref=f"automation-{name}", input_from=source,
                                    on_result=rules, **kwargs))
        if name in {"confirm", "prepare", "decide", "accept"}:
            source = name

    if mode is AutomationMode.REAL and str(trigger.trigger_type) == TriggerType.TAG.value:
        append("confirm", returns=True)
    if mode is not AutomationMode.ACTIONS:
        append("prepare", returns=True)
        if getattr(trigger, "gate", None):
            append("decide", returns=True)
    if mode in (AutomationMode.REAL, AutomationMode.TEST):
        append("accept", returns=True)
    if mode is not AutomationMode.PREVIEW:
        if include_graph and mode is not AutomationMode.ACTIONS:
            append("activate", on_fail=ON_FAIL_CONTINUE)
        if declared is not None:
            append("then", on_fail=ON_FAIL_CONTINUE if has_instruction else ON_FAIL_ABORT)
        else:
            actions = [trigger.action] if hook else trigger.actions
            for index, _ in enumerate(actions):
                steps.append(WizardStepSpec(id=f"action_{index + 1}", ref="automation-action",
                                           input_value=index, on_fail=ON_FAIL_CONTINUE))
        if has_instruction:
            append("instruction", on_fail=ON_FAIL_CONTINUE)
    if not steps:
        append("noop")

    return WizardSpec(name=f"automation-{getattr(trigger, 'id', '') or trigger.name}", steps=steps), _resolve_operation
