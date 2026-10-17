"""A FlowCall log is an eval set: label its rows, and the generic eval replays the block and judges it."""
import json

import pytest

from flow_sdk import evals
from flow_sdk.builtin.compute_op import ComputeOp
from flow_sdk.builtin.dataset import Dataset
from flow_sdk.core import log_dataset
from flow_sdk.core.compute_op import call_log, run_op
from flow_sdk.core.compute_op.context import CallContext
from flow_sdk.evals.compare import compare
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec, PythonOp

pytestmark = pytest.mark.timeout(5)

DOUBLE = "return ReturnedValue.satisfied(value=input * 2)"


@pytest.fixture(autouse=True)
def temp(monkeypatch, tmp_path):
    from flow_sdk import config

    monkeypatch.setattr(config, "FLOWPAD_TEMP_DIR", str(tmp_path / "temp"))


async def block(tmp_path, body, *, index=True):
    (tmp_path / "agentic-assets/project_manifest").mkdir(parents=True, exist_ok=True)
    (tmp_path / "agentic-assets/project_manifest/project_manifest.json").write_text('{"ns": "flowcall_eval"}')
    folder = tmp_path / "agentic-assets/compute_op/double"
    if index:  # the index writes the block's folder and document
        await ComputeOp(name="double", asset_ref=str(folder), subkind="python", exe_data=PythonOp(),
                        input="int", output="int").save()
    else:
        folder.mkdir(parents=True)
        (folder / "compute_op.json").write_text(json.dumps(
            {"name": "double", "subkind": "python", "exe_data": {}, "input": "int", "output": "int"}))
    write(folder, body)
    spec = ComputeOpSpec(name="double", subkind="python", exe_data={}, input="int", output="int", log={})
    return spec, folder


def write(folder, body):
    (folder / "call.py").write_text("from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\n"
                                    f"async def call(input, *, context):\n    {body}\n")


async def logged(spec, folder, *inputs):
    for n in inputs:
        await run_op(spec, input=n, trusted=True, context=CallContext(asset_folder=folder, workdir=folder))
    await log_dataset.drain()
    return Dataset.at(call_log.log_of(spec).folder())


async def label(ds, golds):
    """A person's review: each row an ``eval`` row with its right answer."""
    for d in log_dataset.rows(ds._folder()):
        row = ds.row(d.name)
        keep = {k: row[k] for k in ("input", "output", "data") if row.get(k) is not None}
        await ds.put(d.name, {**keep, "kind": "eval", "ground_truth": {"value": golds[row["input"]["value"]]}})


async def test_the_log_is_judged_by_the_generic_eval_and_versions_compare(tmp_path):
    spec, folder = await block(tmp_path, DOUBLE)
    ds = await logged(spec, folder, 1, 2)
    await label(ds, {1: 2, 2: 5})  # 2 * 2 is not 5: one label the block gets wrong
    first, _ = await evals.run(ds)
    assert first.eval_name == "flowcall"
    assert (first.counts["correct"], first.counts["wrong"]) == (1, 1)
    [version] = first.slices["labels.version"]
    write(folder, "return ReturnedValue.satisfied(value=5 if input == 2 else input * 2)")
    second, _ = await evals.run(ds)
    assert second.counts["correct"] == 2 and version not in second.slices["labels.version"]
    from flow_sdk.evals.store import load

    runs = ds._folder()
    change = compare(load(runs, first.run_id), load(runs, second.run_id))
    assert len(change.fixed) == 1 and not change.broken


async def test_a_block_this_instance_does_not_know_is_not_run(tmp_path):
    spec, folder = await block(tmp_path, DOUBLE, index=False)
    ds = await logged(spec, folder, 1)
    await label(ds, {1: 2})
    write(folder, "raise RuntimeError('must never run')")
    run, _ = await evals.run(ds, out_dir=tmp_path / "runs")
    assert run.counts["error"] == 1


def test_a_kind_with_its_own_eval_keeps_it(tmp_path):
    from flow_sdk.evals.runner import find_evals

    assert [e.name for _, e in find_evals(tmp_path, "navigator.dataset")] == ["navigator"]
    assert [e.name for _, e in find_evals(tmp_path, "")] == ["flowcall"]


async def test_a_prompt_answer_names_the_endpoint_that_answered(monkeypatch):
    from flow_sdk.core.compute_op import runner

    class Endpoint:  # the one thing the prompt leg uses of a box LLM source, and its identity
        typeid = "llm_endpoint-7d3a1e52-0c4b-4f7e-9a51-0f1b2c3d4e5f"

        async def create_completion(self, system, user, timeout=None):
            return "hi"

    async def box():
        return Endpoint()

    monkeypatch.setattr(runner, "_box_llm", box)
    spec = ComputeOpSpec(name="say", subkind="prompt", exe_data={"prompt": "say hi"})
    answer = await run_op(spec, trusted=True)
    assert answer.text == "hi" and answer.endpoint == Endpoint.typeid
