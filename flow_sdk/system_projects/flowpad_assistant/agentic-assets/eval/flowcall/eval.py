"""The generic FlowCall eval: a logged call's input through its block again, judged against the label.

A FlowCall log row (``core/compute_op/call_log``) names the block that answered it (``data.block_folder``).
Each labelled row is replayed through the block as it is NOW, and the answer is judged against the
row's gold by the standard match (``verdict_of``). Every result is labelled with the version and model
that answered, and the report is sliced by them, so a run after a change shows what the change did.

Only a block this instance knows is replayed (``ComputeOp.for_folder``: one its index holds, shipped
or the user's). Anything else is an error row -- running an eval never runs code nobody approved.
"""

from pathlib import Path

from flow_sdk.evals import RowEval, Verdict, verdict_of


async def evaluate_row(row):
    from flow_sdk.builtin.compute_op import ComputeOp  # noqa: PLC0415
    from flow_sdk.core.compute_op import call_log  # noqa: PLC0415
    from flow_sdk.core.compute_op.python import block_version  # noqa: PLC0415

    where = (row.data or {}).get("block_folder")
    op = await ComputeOp.for_folder(where) if where and Path(where).is_dir() else None
    spec = op.spec() if op is not None else None
    if spec is None:
        return RowEval(verdict=Verdict.ERROR, error=f"{where or 'the block'}: not a block this instance knows, so it is not run")
    # Running the eval is the person's go-ahead for a block their own instance indexed and logged.
    answer = await op.call(input=call_log.unwrap(spec, row.input), approved=True)
    labels = {"version": block_version(where), "model": getattr(answer, "endpoint", None) or "—"}
    if not answer.ok or not answer.has_value:
        return RowEval(verdict=Verdict.WRONG, note=answer.detail or "no value", labels=labels)
    prediction = call_log.wrap(spec, call_log.dump(answer.value))
    return RowEval(prediction=prediction, verdict=verdict_of(prediction, row), labels=labels)
