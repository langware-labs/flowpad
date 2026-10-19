"""Durable calls through the real HTTP action dispatcher."""
import asyncio

from flow_sdk.builtin.compute_op import ComputeOp
from flow_sdk.core.compute_op.durable import _tasks
from flow_sdk.schema.data_spec.compute_op_spec import PythonOp


async def test_http_admission_validation_and_retrieval(client, tmp_path):
    manifest = tmp_path / 'agentic-assets/project_manifest/project_manifest.json'
    manifest.parent.mkdir(parents=True)
    manifest.write_text('{"ns":"durable_http"}')
    folder = tmp_path / 'agentic-assets/compute_op/echo'
    op = ComputeOp(name='echo', asset_ref=str(folder), subkind='python', exe_data=PythonOp(), input=['int'], output=['int'])
    await op.save()
    (folder / 'call.py').write_text('from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\nasync def call(input, *, context):\n return ReturnedValue.satisfied(value=input)\n')
    url = f'/api/v1/graph/compute_op/{op.id}'
    assert (await client.get(url)).json()['data']['durable_calls_supported'] is True
    bad = await client.post(url + '/start', json={'approved': True, 'input': ['bad']})
    assert bad.status_code == 422, bad.text
    assert not op._calls_folder().exists()
    admitted = await client.post(url + '/start', json={'approved': True, 'input': [0]})
    assert admitted.status_code == 200, admitted.text
    call = admitted.json()['data']
    assert call['result'] is None
    await asyncio.gather(*tuple(_tasks))
    response = await client.get(url + '/get_call', params={'call_id': call['call_id']})
    assert response.status_code == 200, response.text
    completed = response.json()['data']
    assert completed['state'] == 'completed', completed
    assert completed['result']['value'] == [0]
    assert completed['result']['spec_kind'] == 'compute.returned'
    assert completed['result']['invocation_id'] == call['invocation_id']
    assert (await client.get(url + '/get_call', params={'call_id': '../outside'})).status_code == 422


async def test_http_calls_join_the_callers_run(client, tmp_path):
    from flow_sdk.api.api_types.identifier import mint_uuid

    manifest = tmp_path / 'agentic-assets/project_manifest/project_manifest.json'
    manifest.parent.mkdir(parents=True)
    manifest.write_text('{"ns":"trace_http"}')
    folder = tmp_path / 'agentic-assets/compute_op/who'
    op = ComputeOp(name='who', asset_ref=str(folder), subkind='python', exe_data=PythonOp(), input='int', output=['string'])
    await op.save()
    (folder / 'call.py').write_text('from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\nasync def call(input, *, context):\n return ReturnedValue.satisfied(value=[context.invocation_id, context.parent_call_id or ""])\n')
    url = f'/api/v1/graph/compute_op/{op.id}'
    run, parent = str(mint_uuid()), str(mint_uuid())
    trace = {'invocation_id': run, 'parent_call_id': parent}
    ran = (await client.post(url + '/run', json={'approved': True, 'input': 1, **trace})).json()['data']
    assert (ran['value'], ran['invocation_id']) == ([run, parent], run)
    admitted = (await client.post(url + '/start', json={'approved': True, 'input': 1, **trace})).json()['data']
    assert (admitted['invocation_id'], admitted['parent_call_id']) == (run, parent)
    await asyncio.gather(*tuple(_tasks))
    done = (await client.get(url + '/get_call', params={'call_id': admitted['call_id']})).json()['data']
    assert done['result']['value'] == [run, parent]
    refused = await client.post(url + '/run', json={'approved': True, 'input': 1, 'invocation_id': 'run-1'})
    assert refused.status_code == 422
