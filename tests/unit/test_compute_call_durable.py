"""Real private records and authored Python blocks; no stand-in executor."""
import asyncio
import json
import subprocess
import sys

import pytest

from flow_sdk.builtin.compute_op import ComputeOp
from flow_sdk.core.compute.declared_value import DeclaredShapeError
from flow_sdk.core.compute_op.durable import CallState, _tasks, read
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode


@pytest.fixture
def op(tmp_path):
    folder = tmp_path / "agentic-assets/compute_op/echo"
    folder.mkdir(parents=True)
    manifest = tmp_path / "agentic-assets/project_manifest"
    manifest.mkdir()
    (manifest / "project_manifest.json").write_text(json.dumps({"ns": "test_durable"}))
    (folder / "compute_op.json").write_text(json.dumps({"name": "echo", "subkind": "python", "exe_data": {}, "input": ["int"], "output": ["int"]}))
    (folder / "call.py").write_text("from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\nasync def call(input, context):\n return ReturnedValue.satisfied(value=input)\n")
    yield ComputeOp(name="echo", asset_ref=str(folder))


async def test_concurrent_calls_reconnect_without_replay(op):
    first, second = await asyncio.gather(op.start(input=[], approved=True), op.start(input=[2], approved=True))
    assert first.result is None and first.call_id != second.call_id
    await asyncio.gather(*tuple(_tasks))
    finished = await op.get_call(first.call_id)
    assert finished.error is None
    assert finished.result.value == []
    assert (await op.get_call(second.call_id)).result.value == [2]
    assert (await op.get_call(first.call_id)).state is CallState.COMPLETED


async def test_validation_and_approval_before_effects(op):
    with pytest.raises(DeclaredShapeError):
        await op.start(input=["not an int"], approved=True)
    assert not op._calls_folder().exists()
    call = await op.start(input=[2])
    await asyncio.gather(*tuple(_tasks))
    assert (await op.get_call(call.call_id)).result.exit_code == ExitCode.REFUSED


def test_actual_executor_exit_marks_interrupted_without_replay(op):
    from pathlib import Path

    (Path(op.asset_ref) / "call.py").write_text("import asyncio\nfrom flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess\nasync def call(input, context):\n process = AgenticProcess(name='durable child')\n await process.save()\n context.attach_executor(str(process.typeid))\n print(context.invocation_id, flush=True)\n await asyncio.Event().wait()\n")
    source = '''import asyncio, sys
from pathlib import Path
from flow_sdk.builtin.compute_op import ComputeOp
from flow_sdk.fs_store.record_paths import set_default_records_data_root
async def main():
    set_default_records_data_root(Path(sys.argv[1]))
    op = ComputeOp(id=sys.argv[2], name="echo", asset_ref=sys.argv[3])
    await op.start(input=[], approved=True)
    from flow_sdk.core.compute_op.durable import _tasks
    await asyncio.gather(*tuple(_tasks))
asyncio.run(main())
'''
    process = subprocess.Popen([sys.executable, "-c", source, str(op._calls_folder().parents[2]), op.id, op.asset_ref], stdout=subprocess.PIPE, text=True)
    try:
        call_id = process.stdout.readline().strip()
        running = read(op._calls_folder(), call_id)
        assert running.state is CallState.RUNNING
        assert running.executor.startswith("agentic_process-")
        process.kill()
        process.wait()
        assert read(op._calls_folder(), call_id).state is CallState.INTERRUPTED
        assert read(op._calls_folder(), call_id).result is None
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


@pytest.mark.parametrize('value', [None, False, 0, []])
async def test_completed_explicit_values_survive_new_reader(op, value):
    from pathlib import Path

    folder = Path(op.asset_ref)
    manifest = json.loads((folder / 'compute_op.json').read_text())
    manifest['output'] = '?int' if value is None else 'bool' if isinstance(value, bool) else ['int'] if isinstance(value, list) else 'int'
    (folder / 'compute_op.json').write_text(json.dumps(manifest))
    (folder / 'call.py').write_text(f'from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\nasync def call(input, *, context):\n return ReturnedValue.satisfied(value={value!r})\n')
    admitted = await op.start(input=[], approved=True)
    await asyncio.gather(*tuple(_tasks))
    restored = read(op._calls_folder(), admitted.call_id)
    assert restored.error is None
    assert restored.result.has_value and restored.result.value == value
    assert restored.result.invocation_id == admitted.invocation_id
