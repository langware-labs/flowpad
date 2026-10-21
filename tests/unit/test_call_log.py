"""A block that opts in logs every call as a dataset row in temp; a run is read back as one tree."""
import json

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core import log_dataset
from flow_sdk.core.compute_op import call_log, run_op
from flow_sdk.core.compute_op.context import CallContext
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec

pytestmark = pytest.mark.timeout(5)


@pytest.fixture(autouse=True)
def temp(monkeypatch, tmp_path):
    from flow_sdk import config

    monkeypatch.setattr(config, "FLOWPAD_TEMP_DIR", str(tmp_path / "temp"))
    return tmp_path / "temp"


def block(tmp_path, name, body="return ReturnedValue.satisfied(value=input)", log=None, output="int"):
    manifest = tmp_path / "agentic-assets/project_manifest/project_manifest.json"
    if not manifest.exists():
        manifest.parent.mkdir(parents=True)
        manifest.write_text(json.dumps({"ns": "test_call_log"}))
    folder = tmp_path / "agentic-assets/compute_op" / name
    folder.mkdir(parents=True)
    (folder / "call.py").write_text(
        "from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\n"
        f"async def call(input, *, context):\n    {body}\n")
    spec = ComputeOpSpec(name=name, subkind="python", input="int", output=output, exe_data={},
                         **({"log": log} if log is not None else {}))
    return spec, folder


async def call(spec, folder, input, *, run=None, parent=None, call_id=None):
    context = CallContext(asset_folder=folder, workdir=folder, invocation_id=run or str(mint_uuid()), parent_call_id=parent)
    answer = await run_op(spec, input=input, trusted=True, context=context, call_id=call_id)
    await log_dataset.drain()
    return answer


def rows(spec):
    from flow_sdk.builtin.dataset import Dataset

    folder = call_log.log_of(spec).folder()
    return [Dataset.at(folder).row(d.name) for d in log_dataset.rows(folder)]


async def test_no_log_declared_writes_nothing(tmp_path, temp):
    spec, folder = block(tmp_path, "quiet")
    assert (await call(spec, folder, 1)).value == 1
    assert "log" not in spec.model_dump(mode="json")
    from flow_sdk.schema.data_spec.compute_op_spec import CallLogSpec

    assert not call_log.log_of(spec.model_copy(update={"log": CallLogSpec()})).folder().exists()


async def test_a_call_is_a_row_with_its_trace(tmp_path):
    spec, folder = block(tmp_path, "echo", log={})
    run, parent, me = (str(mint_uuid()) for _ in range(3))
    await call(spec, folder, 7, run=run, parent=parent, call_id=me)
    [row] = rows(spec)
    assert (row["input"], row["output"]) == ({"value": 7}, {"value": 7})
    data = row["data"]
    assert (data["invocation_id"], data["call_id"], data["parent_call_id"]) == (run, me, parent)
    assert (data["block"], data["exit_code"]) == ("echo", "OK")


async def test_the_run_reads_back_as_a_tree(tmp_path):
    outer, outer_folder = block(tmp_path, "outer", log={})
    inner, inner_folder = block(tmp_path, "inner", log={})
    run, top = str(mint_uuid()), str(mint_uuid())
    await call(outer, outer_folder, 1, run=run, call_id=top)
    await call(inner, inner_folder, 2, run=run, parent=top)
    await call(inner, inner_folder, 3, run=run, parent=top)
    await call(inner, inner_folder, 4)  # another run: not in this trace
    [root] = call_log.trace(run)
    assert (root["block"], root["call_id"]) == ("outer", top)
    assert [c["block"] for c in root["children"]] == ["inner", "inner"]


async def test_oldest_rows_go_past_max_rows(tmp_path):
    spec, folder = block(tmp_path, "small", log={"max_rows": 2})
    for n in (1, 2, 3):
        await call(spec, folder, n)
    assert [r["input"]["value"] for r in rows(spec)] == [2, 3]


async def test_an_output_too_big_is_dropped_and_the_trace_kept(tmp_path):
    spec, folder = block(tmp_path, "big", body='return ReturnedValue.satisfied(value="x" * 500)',
                         log={"max_row_bytes": 100}, output="string")
    await call(spec, folder, 1)
    [row] = rows(spec)
    assert row.get("output") is None
    assert row["data"]["truncated"] == ["output"] and row["data"]["call_id"]


async def test_an_input_too_big_is_not_logged(tmp_path):
    spec, folder = block(tmp_path, "wide", log={"max_row_bytes": 1})
    await call(spec, folder, 123456)
    assert rows(spec) == []


async def test_promote_copies_the_whole_run(tmp_path):
    from flow_sdk.builtin.dataset import Dataset

    spec, folder = block(tmp_path, "keep", log={})
    run = str(mint_uuid())
    for n in (1, 2):
        await call(spec, folder, n, run=run)
    await call(spec, folder, 9)
    kept = log_dataset.TempLog("kept", "Kept", call_log.log_of(spec).spec, "kept")
    kept._create()
    ids = await call_log.promote(run, Dataset.at(kept.folder()))
    assert len(ids) == 2
    assert sorted(r["input"]["value"] for r in (Dataset.at(kept.folder()).row(i) for i in ids)) == [1, 2]


async def test_a_broken_temp_folder_never_breaks_the_call(tmp_path, monkeypatch):
    from flow_sdk import config

    blocker = tmp_path / "not-a-dir"
    blocker.write_text("")
    monkeypatch.setattr(config, "FLOWPAD_TEMP_DIR", str(blocker))
    spec, folder = block(tmp_path, "sturdy", log={})
    assert (await call(spec, folder, 5)).value == 5


def test_log_spec_reads_from_the_document():
    spec = ComputeOpSpec.model_validate(json.loads(
        '{"name": "n", "subkind": "python", "exe_data": {}, "input": "int", "log": {"dataset_kind": "navigator.dataset"}}'))
    assert spec.log.dataset_kind == "navigator.dataset" and spec.log.max_rows == 500
    assert call_log.log_of(spec).spec == "navigator.dataset"


async def test_cli_trace_prints_the_run(tmp_path):
    from typer.testing import CliRunner

    from flow_sdk.cli.commands.op_cmd import op_app

    spec, folder = block(tmp_path, "shown", log={})
    run = str(mint_uuid())
    await call(spec, folder, 1, run=run)
    shown = CliRunner().invoke(op_app, ["trace", run])
    assert shown.exit_code == 0 and '"shown"' in shown.output
    assert CliRunner().invoke(op_app, ["trace", str(mint_uuid())]).exit_code == 4


async def test_a_row_names_the_version_that_answered_it(tmp_path):
    from flow_sdk.core.compute_op.python import block_version

    spec, folder = block(tmp_path, "versioned", log={})
    await call(spec, folder, 1)
    before = block_version(folder)
    assert block_version(folder) == before  # an unchanged folder: the same version
    (folder / "call.py").write_text((folder / "call.py").read_text() + "\n# changed\n")
    await call(spec, folder, 2)
    first, second = (r["data"] for r in rows(spec))
    assert first["version"] == before != second["version"]
    assert (first["block_folder"], first["model"]) == (str(folder), None)
