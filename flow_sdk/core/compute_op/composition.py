"""Value composition over the existing ComputeOp and Wizard runners.

``chain`` passes whole values; ``map_calls`` is explicitly per-item. Neither
accepts arbitrary Python callbacks as a second implementation mechanism.
"""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any, Callable

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core.compute.declared_value import MISSING
from flow_sdk.core.compute_op.runner import run_op
from flow_sdk.core.wizard.runner import Resolved, run_wizard
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec, OpSubkind
from flow_sdk.schema.data_spec.returned_value_spec import CollectionResult, ExitCode, ItemAnswer
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec, WizardStepSpec


async def _target(op, *, context=None, resolve_op=None) -> Resolved | None:
    if isinstance(op, ComputeOpSpec):
        return Resolved(op, asset_folder=getattr(context, "asset_folder", None))
    if isinstance(op, str):
        if resolve_op is not None:
            return await resolve_op(op)
        from flow_sdk.builtin.compute_op import ComputeOp

        op = await ComputeOp.resolve(op, project=getattr(context, "project", None))
        if op is None:
            return None
    spec = op.spec()
    return None if spec is None else Resolved(spec, op.is_system(), Path(op.asset_ref) if op.asset_ref else None, op.project_id)


class CallChain:
    def __init__(self, ops):
        if not ops:
            raise ValueError("a chain needs at least one block")
        self.ops = ops

    async def call(self, *, input=MISSING, context=None, approved=False, workdir=None, resolve_op=None):
        from flow_sdk.schema.data_spec.returned_value_spec import WizardResult

        resolved = []
        for op in self.ops:
            found = await _target(op, context=context, resolve_op=resolve_op)
            if found is None:
                return WizardResult.not_found(f"no block {op!r}")
            resolved.append(found)
        for before, after in zip(resolved, resolved[1:]):
            output = before.spec.output_shape
            if output is None or after.spec.input is None:
                raise ValueError(f"{before.spec.name!r} and {after.spec.name!r} need declared output/input to chain")
        steps = [WizardStepSpec(id=f"step_{i}", ref=str(i), **(
            {"input_from": f"step_{i - 1}"} if i else ({"input_from": "$input"} if input is not MISSING else {})
        )) for i in range(len(resolved))]
        spec = WizardSpec(name="FlowCall chain", steps=steps,
                          output=resolved[-1].spec.output_shape, output_from=steps[-1].id)

        async def lookup(ref):
            return resolved[int(ref)]

        return await run_wizard(spec, trusted=True, approved=approved, input=input,
                                context=context, workdir=workdir, resolve_op=lookup,
                                parent=getattr(context, "parent", None),
                                activity_path=f"flowcall/chain-{mint_uuid()}")


def chain(*ops) -> CallChain:
    """Compose block specs, entities or scoped references without an alternate step runner."""
    return CallChain(ops)


async def map_calls(op, items: list, *, context=None, approved=False, on_error="stop",
                    key: Callable[[Any], str] | None = None, workdir=None, resolve_op=None) -> CollectionResult:
    """Call once per item; returned failures may be collected, exceptions always propagate."""
    if not isinstance(items, list):
        raise ValueError("map_calls takes a list")
    if on_error not in ("stop", "collect"):
        raise ValueError("on_error must be 'stop' or 'collect'")
    found = await _target(op, context=context, resolve_op=resolve_op)
    if found is None:
        return CollectionResult.not_found(f"no block {op!r}")
    if not (approved or found.trusted):
        return CollectionResult.refused(f"block {found.spec.name!r} needs approval")
    if found.spec.subkind is OpSubkind.PYTHON and found.asset_folder is None and context is None:
        raise ValueError("a Python block requires its explicit asset folder")
    produces = found.spec.output_shape is not None
    if found.asset_folder is not None or context is None:
        if context is None:
            from flow_sdk.core.compute_op.context import CallContext

            context = CallContext(asset_folder=found.asset_folder or Path(workdir or Path.cwd()), workdir=workdir,
                                  project=found.project, shipped=found.trusted)
        else:
            context = replace(context, asset_folder=found.asset_folder,
                              project=found.project or context.project, shipped=found.trusted)
    from flow_sdk.activity import Activity

    correlation = getattr(context, "invocation_id", None) or str(mint_uuid())

    async def execute(root):
        results, values = [], []
        code = ExitCode.OK
        root.label(found.spec.display_label).total(len(items))
        for index, item in enumerate(items):
            item_key = key(item) if key is not None else None
            if item_key is not None and not isinstance(item_key, str):
                raise ValueError("map item key must be a string")
            child = root.child(str(index)).label(item_key if item_key is not None else str(index))
            child_context = replace(context, parent=child) if context is not None else None
            try:
                answer = await run_op(found.spec, input=item, trusted=True,
                                      asset_folder=found.asset_folder, context=child_context, workdir=workdir)
            except BaseException as exc:
                child.fail(str(exc) or type(exc).__name__)
                root.fail(str(exc) or type(exc).__name__)
                raise
            results.append(ItemAnswer(index=index, key=item_key, answer=answer))
            usable = answer.exit_code is ExitCode.OK and answer.has_value if produces else answer.ok
            if usable:
                child.done(answer.detail or "done")
                root.inc_success()
                if produces:
                    values.append(answer.value)
            else:
                child.fail(answer.detail or "no consumable value")
                root.inc_error(answer.detail, ref=str(index))
                code = ExitCode.REFUSED if answer.exit_code is ExitCode.REFUSED else ExitCode.NOT_YET
                if code is ExitCode.REFUSED or on_error == "stop":
                    break
        present = produces and code is ExitCode.OK
        if code is not ExitCode.OK:
            root.fail("one or more items did not reach their goal")
        else:
            root.done()
        return CollectionResult(exit_code=code, items=results,
                                value=values if present else None, value_present=present,
                                invocation_id=correlation,
                                ran=any(item.answer.ran for item in results))

    parent = getattr(context, "parent", None)
    if parent is not None:
        return await execute(parent.child(f"map-{mint_uuid()}"))
    async with Activity.claim(f"flowcall/map-{correlation}", queue=False) as root:
        return await execute(root)
