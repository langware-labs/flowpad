"""What a wizard run will ask a person, read off the wizard BEFORE it runs — and asked at once.

A wizard asks through ``ask`` ops, each raised when the run reaches it. A run with five of them
stops five times, minutes apart, and the person has to stay for all of it. So before the first
step the run is PLANNED: the same walk the runner makes, checking each ask op's goal and doing
nothing else. Every question whose goal does not hold yet is one need (an ``AskItemSpec``); they are put
to the person as ONE question (``Question.items``), and the run then takes each ask's answer from
that list instead of raising it.

Not every question can be asked early. One is left where it is — asked in place, exactly as
before — when its answer only means something at its moment in the run:

* a gate (``recheck`` / ``auto_continue``): its answer is "the thing I did elsewhere is done";
* one that shows, or is called with, a value an EARLIER step produces (``{{connect.link}}``);
* a typed answer nobody keeps (no ``bind``, no wizard ``output``): "type ok when you have sent
  it" is a moment, not an input;
* one the list cannot draw whole: several fields, a file, a choice of ways, an AI Assist.

A plan takes no slot and writes nothing: it is a look, not a run.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from flow_sdk.core.compute.exec import run_shell
from flow_sdk.core.compute_op.runner import Shell, check_op, fill, placeholders
from flow_sdk.core.wizard.runner import MAX_WIZARD_DEPTH, _allowed, _scope, _step_path, _unmatched
from flow_sdk.core.wizard.state import input_env
from flow_sdk.schema.data_spec.compute_op_spec import AskItemSpec, AskOp, ComputeOpSpec, fields_of_kind
from flow_sdk.schema.data_spec.confirm_spec import ConfirmSpec
from flow_sdk.schema.data_spec.returned_value_spec import AskResult, ExitCode
from flow_sdk.schema.data_spec.wizard_spec import StepKind, WizardPlanSpec, WizardSpec


@dataclass
class _Plan:
    """One plan's fixed parts, and what it collects."""

    workdir: Path
    platform: str
    shell: Shell
    resolve_op: Any
    resolve_wizard: Any
    approved: bool
    needs: list[AskItemSpec] = field(default_factory=list)
    #: The longest any need's own question would have waited; ``None`` once one has no deadline.
    timeout: Optional[float] = 0.0


async def plan_wizard(
    spec: WizardSpec,
    *,
    workdir: Path,
    platform: str = "",
    shell: Shell = run_shell,
    inputs: Optional[dict] = None,
    resolve_op: Any = None,
    resolve_wizard: Any = None,
    approved: bool = False,
) -> WizardPlanSpec:
    """Every question a run of *spec* would raise that can be asked before it starts."""
    plan = _Plan(
        workdir=workdir, platform=platform or sys.platform, shell=shell, resolve_op=resolve_op,
        resolve_wizard=resolve_wizard, approved=approved,
    )
    await _walk(plan, spec, values=dict(inputs or {}), produced=set(), path=(), chain=(), required=True)
    return WizardPlanSpec(needs=plan.needs, timeout_seconds=plan.timeout)


async def _walk(
    plan: _Plan,
    spec: WizardSpec,
    *,
    values: dict,
    #: Names whose value an earlier step PRODUCES — unknown until the run gets there.
    produced: "set[str]",
    path: tuple[str, ...],
    chain: tuple[str, ...],
    required: bool,
) -> None:
    for step in spec.steps:
        # Typed inputs are resolved and validated when the step is reached. Asking early
        # could execute a check before validation or before the producing step exists.
        if step.input_from is not None or "input_value" in step.model_fields_set:
            if step.bind:
                produced.add(step.bind)
            continue
        # A ``when`` that waits on a produced value is not known yet, so nothing under it is planned.
        if not (set(step.when) & produced) and not _unmatched(values, step):
            scope = _scope(values, step)
            late = (produced - set(step.args)) | {name for name, source in step.args.items() if source in produced}
            if step.kind is StepKind.WIZARD:
                above = (*chain, spec.name or "")
                callee = await _trusted(plan, plan.resolve_wizard, step.ref)
                if callee is not None and step.ref not in above and len(above) <= MAX_WIZARD_DEPTH:
                    await _walk(
                        plan, callee, values=scope, produced=late, path=(*path, step.id), chain=above,
                        required=required and step.required,
                    )
            else:
                op = await _trusted(plan, plan.resolve_op, step.ref)
                if op is not None and _askable_early(op, late, kept=bool(step.bind or spec.output or spec.output_from == step.id)):
                    env = input_env(scope)
                    said = await check_op(op, workdir=plan.workdir, platform=plan.platform, env=env, shell=plan.shell)
                    if said.exit_code is ExitCode.NOT_YET:
                        exe = op.exe_data
                        plan.needs.append(AskItemSpec(
                            path=_step_path(path, step),
                            op=op.name,
                            prompt=fill(exe.prompt or step.display_label, env),
                            detail=fill(exe.detail, env),
                            kind=op.output_shape,
                            secret=exe.secret,
                            required=required and step.required,
                        ))
                        if exe.until_answered or plan.timeout is None:
                            plan.timeout = None
                        else:
                            plan.timeout = max(plan.timeout, exe.timeout())
        if step.bind:
            produced.add(step.bind)


async def _trusted(plan: _Plan, resolver: Any, ref: str) -> Any:
    """The callee's spec when the run would be allowed to call it; else None (the run says why)."""
    found = await resolver(ref) if resolver is not None else None
    return found.spec if found is not None and _allowed(found, plan.approved) else None


def _askable_early(op: ComputeOpSpec, produced: "set[str]", *, kept: bool) -> bool:
    exe = op.exe_data
    if not isinstance(exe, AskOp):
        return False
    if exe.recheck or exe.auto_continue or exe.choices or exe.file or exe.assist_agent:
        return False
    if (placeholders(exe.prompt) | placeholders(exe.detail)) & produced:
        return False
    shape = op.output_shape
    if not isinstance(shape, str):
        return False  # Inline records/lists are asked in place; AskItemSpec carries a kind name.
    if shape == ConfirmSpec.spec_kind:
        return True  # An approval is an approval whenever it is given.
    # One typed value, and somebody keeps it.
    return isinstance(fields_of_kind(shape), str) and kept


async def ask_needs(
    spec: WizardSpec,
    plan: WizardPlanSpec,
    *,
    wizard_id: str = "",
) -> "dict[str, AskResult]":
    """Put every need to the person as ONE question; what they said, per need.

    Each answer is the ``AskResult`` its own question would have returned — answered, cancelled,
    timed out, or never shown — so the step it belongs to behaves as it always did. A list nobody
    could be shown is every question nobody could be shown: none of them is then raised again in
    its own place, only to wait out the same absence once more.
    """
    from flow_sdk.core.compute_op.ask import ask_person, ask_through_backend, served_here  # noqa: PLC0415

    ask = ask_person if served_here() else ask_through_backend
    said = await ask(
        spec.name or "wizard",
        spec.display_label,
        None,
        timeout=plan.timeout_seconds,
        label=spec.display_label,
        detail=spec.description,
        items=plan.needs,
        wizard_id=wizard_id,
    )
    if not said.ok:
        # One ending for the whole list: cancelled, timed out, or not shown.
        return {need.path: said for need in plan.needs}
    given = said.value if isinstance(said.value, dict) else {}
    return {
        need.path: (
            AskResult.satisfied(f"{need.prompt}: answered.", value=given[need.path])
            if need.path in given
            else AskResult.not_yet(f"{need.prompt}: cancelled.", cancelled=True)
        )
        for need in plan.needs
    }
