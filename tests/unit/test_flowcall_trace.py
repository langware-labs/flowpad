"""One run, one ``invocation_id``: every call in it names the call that made it (``parent_call_id``)."""
import json

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core.compute_op.context import CallContext
from flow_sdk.core.wizard.runner import run_wizard
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec
from tests.unit.test_flowcall_composition import python_blocks

pytestmark = pytest.mark.timeout(5)

#: A block whose value is the trace it ran under.
WHO = 'return ReturnedValue.satisfied(value=[context.invocation_id, context.call_id, context.parent_call_id or ""])'


@pytest.mark.asyncio
async def test_map_items_are_children_of_the_calling_call(tmp_path):
    from flow_sdk.core.compute_op.composition import map_calls

    resolve = python_blocks(tmp_path, [('who', 'int', ['string'], WHO)])
    caller = CallContext(asset_folder=tmp_path, workdir=tmp_path, call_id=str(mint_uuid()))
    answer = await map_calls('who', [1, 2], context=caller, approved=True, workdir=tmp_path, resolve_op=resolve)
    traces = answer.value
    assert {t[0] for t in traces} == {caller.invocation_id}
    assert {t[2] for t in traces} == {caller.call_id}
    assert len({t[1] for t in traces} | {caller.call_id}) == 3  # every item is its own call


@pytest.mark.asyncio
async def test_a_map_nobody_called_is_a_root(tmp_path):
    from flow_sdk.core.compute_op.composition import map_calls

    resolve = python_blocks(tmp_path, [('who', 'int', ['string'], WHO)])
    answer = await map_calls('who', [1], approved=True, workdir=tmp_path, resolve_op=resolve)
    assert answer.value[0][2] == ''


@pytest.mark.asyncio
async def test_wizard_steps_are_children_of_the_calling_call(tmp_path):
    resolve = python_blocks(tmp_path, [('who', 'int', ['string'], WHO)])
    caller = CallContext(asset_folder=tmp_path, workdir=tmp_path, call_id=str(mint_uuid()))
    spec = WizardSpec(name='w', output=['string'], output_from='a',
                      steps=[{'id': 'a', 'ref': 'who', 'input_from': '$input'}])
    answer = await run_wizard(spec, trusted=True, input=1, context=caller, resolve_op=resolve, workdir=tmp_path)
    run, call, parent = answer.value
    assert (run, parent) == (caller.invocation_id, caller.call_id)
    assert call != caller.call_id


@pytest.mark.asyncio
async def test_durable_start_joins_the_callers_run(tmp_path):
    from flow_sdk.core.compute_op import durable
    from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue

    run, parent = str(mint_uuid()), str(mint_uuid())

    async def execute(identity, attach):
        return ReturnedValue.satisfied()

    joined = durable.start(tmp_path, block='b', project_id=None, input=None, input_present=False,
                           execute=execute, invocation_id=run, parent_call_id=parent)
    root = durable.start(tmp_path, block='b', project_id=None, input=None, input_present=False, execute=execute)
    assert (joined.invocation_id, joined.parent_call_id) == (run, parent)
    assert joined.call_id != run
    assert (root.invocation_id, root.parent_call_id) == (root.call_id, None)
    assert durable.read(tmp_path, joined.call_id).parent_call_id == parent
    await __import__('asyncio').gather(*tuple(durable._tasks))


def _process(context_data):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    return AgenticProcess(name='worker', context_data=context_data)


def test_worker_env_carries_the_run_it_was_spawned_for(monkeypatch):
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import apply_worker_env
    from flow_sdk.utils.environment import inherited_trace

    run, call = str(mint_uuid()), str(mint_uuid())
    env = apply_worker_env({}, _process({'invocation_id': run, 'call_id': call}))
    assert (env['FLOWPAD_INVOCATION_ID'], env['FLOWPAD_PARENT_CALL_ID']) == (run, call)
    for name in ('FLOWPAD_INVOCATION_ID', 'FLOWPAD_PARENT_CALL_ID'):
        monkeypatch.setenv(name, env[name])
    assert inherited_trace() == {'invocation_id': run, 'parent_call_id': call}


def test_worker_no_call_spawned_has_no_trace():
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import apply_worker_env

    stale = {'FLOWPAD_INVOCATION_ID': str(mint_uuid()), 'FLOWPAD_PARENT_CALL_ID': 'x'}
    env = apply_worker_env(dict(stale), _process({'invocation_id': 'not-a-uuid'}))
    assert 'FLOWPAD_INVOCATION_ID' not in env and 'FLOWPAD_PARENT_CALL_ID' not in env


def test_cli_call_body_sends_the_inherited_trace(monkeypatch):
    from flow_sdk.cli.commands.op_cmd import _call_body

    monkeypatch.delenv('FLOWPAD_INVOCATION_ID', raising=False)
    assert 'invocation_id' not in _call_body(False, None, None)
    run = str(mint_uuid())
    monkeypatch.setenv('FLOWPAD_INVOCATION_ID', run)
    monkeypatch.delenv('FLOWPAD_PARENT_CALL_ID', raising=False)
    assert _call_body(False, '1', None) == {'approved': False, 'invocation_id': run, 'parent_call_id': None, 'input': 1}


@pytest.mark.asyncio
async def test_process_call_stamps_the_senders_run_on_the_agent(monkeypatch, tmp_path):
    from flow_sdk.core.compute import process_call
    from flow_sdk.schema.data_spec.compute_op_spec import AgentOp
    from flow_sdk.schema.data_spec.process_call_spec import ProcessCall
    from flow_sdk.schema.data_spec.returned_value_spec import PromptResult

    seen = {}

    async def launch(**kwargs):
        seen.update(kwargs['context_data'])
        return PromptResult.not_yet('stop here')

    monkeypatch.setattr(process_call, 'launch_step_process', launch)
    run = str(mint_uuid())
    call = ProcessCall(call_id=str(mint_uuid()), exe=AgentOp(agent='a', prompt='p'), invocation_id=run)
    await process_call.run_process_call(call, workdir=tmp_path)
    assert seen == {'invocation_id': run, 'call_id': call.call_id}
    legacy = ProcessCall.model_validate(json.loads(call.model_dump_json(exclude={'invocation_id'})))
    await process_call.run_process_call(legacy, workdir=tmp_path)
    assert seen['invocation_id'] == legacy.call_id  # an older sender's call is a run of its own
