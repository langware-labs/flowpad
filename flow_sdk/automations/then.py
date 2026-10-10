"""A rule's ``then`` is a wizard: build it from the document's form and run it with the fire's scope.

``ThenSpec`` says it four ways — a wizard by name, inline steps (with inline ops), or the two
sugars ``run_agent`` / ``run_script``. All four become ONE ``WizardSpec`` plus the ops it
names, and ``run_then`` runs it through the ordinary wizard runner with the fire's values in
scope: the subject's state under its scope key, the launch context under ``LAUNCH``, the
causing envelope under ``EVENT``.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, Optional

from flow_sdk.schema.data_spec.compute_op_spec import AgentOp, CliOp, ComputeOpSpec, OpSubkind
from flow_sdk.schema.data_spec.returned_value_spec import WizardResult
from flow_sdk.schema.data_spec.trigger_spec import ThenSpec
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec, WizardStepSpec

logger = logging.getLogger(__name__)

#: The scope names a fire puts in: the launch context an agent step stamps, the causing envelope.
LAUNCH_KEY = "LAUNCH"
EVENT_KEY = "EVENT"
#: The agent step's id in a sugar-made wizard — what a run reads its process off.
AGENT_STEP = "handle"


def as_wizard(then: ThenSpec, *, name: str, scope_key: str = "", parent_type_id: str = "",
              label: str = "") -> tuple[WizardSpec, dict[str, ComputeOpSpec]]:
    """The wizard a ``then`` runs, and the inline ops its steps name. A ``ref`` answers an empty
    spec whose one step calls the named wizard. *scope_key* names the value the fire put in scope
    for the sugar's agent to take as its input — empty when the fire has none (a rule with no gate),
    and the agent then runs with no input. *label* names a sugar's one op (the agent's name — what a
    person reads on the message's chip); the rule's name otherwise."""
    if then.ref:
        return WizardSpec(name=name, steps=[WizardStepSpec(id="run", kind="wizard", ref=then.ref)]), {}
    if then.run_agent is not None:
        op = ComputeOpSpec(
            name=f"{name}-agent",
            label=label or name,
            subkind=OpSubkind.AGENT,
            exe_data=AgentOp(
                agent=then.run_agent.agent or parent_type_id,
                prompt=then.run_agent.prompt,
                input=scope_key,
                launch_context=LAUNCH_KEY,
            ),
        )
        return WizardSpec(name=name, steps=[WizardStepSpec(id=AGENT_STEP, ref=op.name)]), {op.name: op}
    if then.run_script is not None:
        command = then.run_script
        op = ComputeOpSpec(
            name=f"{name}-script", label=label or name, subkind=OpSubkind.CLI,
            exe_data=CliOp(commands={"darwin": command, "linux": command, "win32": command}),
        )
        return WizardSpec(name=name, steps=[WizardStepSpec(id="run", ref=op.name)]), {op.name: op}
    ops: dict[str, ComputeOpSpec] = {}
    for key, op in (then.ops or {}).items():
        spec = op if isinstance(op, ComputeOpSpec) else ComputeOpSpec.model_validate({"name": key, **op})
        ops[key] = spec if spec.name else spec.model_copy(update={"name": key})
    return WizardSpec(name=name, steps=list(then.steps)), ops


def then_of(trigger: Any) -> Optional[ThenSpec]:
    raw = getattr(trigger, "then", None)
    if not raw:
        return None
    return raw if isinstance(raw, ThenSpec) else ThenSpec.model_validate(raw)


async def run_then(trigger: Any, *, inputs: dict[str, Any], scope_key: str = "") -> WizardResult:
    """Run the rule's wizard with the fire's values in scope (*scope_key* names the one the sugar's
    agent takes as input, when the fire has one). Never raises for an outcome."""
    from flow_sdk.core.wizard.execute import _resolve_op, _resolve_wizard  # noqa: PLC0415
    from flow_sdk.core.wizard.runner import Resolved, run_wizard  # noqa: PLC0415

    then = then_of(trigger)
    if then is None:
        return WizardResult.not_applicable("this rule has nothing to run", ran=False)
    parent = str(getattr(trigger, "parent_type_id", "") or "")
    # The agent's name (the session is named for it) and the rule's folder: independent lookups.
    agent_name, folder = await asyncio.gather(
        _agent_name((then.run_agent.agent or parent) if then.run_agent is not None else ""),
        _workdir(trigger),
    )
    spec, inline = as_wizard(then, name=str(getattr(trigger, "name", "") or "automation"), scope_key=scope_key,
                             parent_type_id=parent, label=agent_name or "")

    async def resolve_op(name: str):
        if name in inline:
            # Inline ops are the rule's own words, trusted as the rule is: a rule a person saved
            # runs what it says, exactly as its actions always did.
            return Resolved(inline[name], trusted=True)
        return await _resolve_op(name)

    return await run_wizard(
        spec,
        trusted=True,
        workdir=folder or Path.cwd(),
        inputs=inputs,
        resolve_op=resolve_op,
        resolve_wizard=_resolve_wizard,
        activity_path=f"automation/{getattr(trigger, 'id', '') or spec.name}",
        subject_entity=str(getattr(trigger, "typeid", "") or "") or None,
    )


async def _agent_name(ref: str) -> str:
    if not ref:
        return ""
    try:
        from flow_sdk.builtin.agent_registry import get_agent  # noqa: PLC0415

        agent = await get_agent(ref)
        return str(getattr(agent, "name", "") or "")
    except Exception:  # noqa: BLE001 — a label is sugar; the run goes on
        return ""


async def _workdir(trigger: Any) -> Optional[Path]:
    """The rule's project folder when it has one (a convenience; the run goes on without)."""
    from flow_sdk.diagnose.runner import project_path_of  # noqa: PLC0415

    path = await project_path_of(str(getattr(trigger, "project_id", "") or "") or None)
    return Path(path) if path else None
