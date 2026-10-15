"""Real HTTP and WS dispatch preserve FlowCall answers, without an agent harness."""
import shlex
import sys

import pytest
from starlette.testclient import TestClient

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.compute_op import ComputeOp
from flow_sdk.schema.data_spec.compute_op_spec import CliOp, ComputeOpSpec
from flow_sdk.server.app import app

pytestmark = [pytest.mark.usefixtures('reset_db_for_testclient'), pytest.mark.timeout(30)]


def _ws_call(ws, kind, entity_id, action, body):
    message_id = mint_uuid()
    ws.send_json(dict(message_type='rest_api_msg', message_id=message_id, method='POST',
                      target_typeid={'type': kind, 'id': entity_id}, action=action, body=body))
    while True:
        reply = ws.receive_json()
        if reply.get('response_message_id') == message_id:
            return reply['content']


def test_compute_op_outcomes_match_and_each_mutation_runs_once(tmp_path):
    count = tmp_path / 'count'
    script = tmp_path / 'command.py'
    script.write_text("from pathlib import Path\np=Path(" + repr(str(count)) + ")\np.write_text((p.read_text() if p.exists() else '')+'x')\nprint('42')\n")
    spec = ComputeOpSpec(name='flowcall-transport', subkind='cli', output_spec_kind='int',
                         exe_data=CliOp(commands={sys.platform: f'{shlex.quote(sys.executable)} {shlex.quote(str(script))}'}))
    op = ComputeOp(name=spec.name, asset_ref=str(tmp_path / 'agentic-assets' / 'compute_op' / spec.name), subkind='cli', exe_data=spec.exe_data, output_spec_kind='int')
    with TestClient(app) as client:
        client.portal.call(op.save)
        with client.websocket_connect(f'/api/v1/connect/ws/{mint_uuid()}') as ws:
            ws.receive_json()  # handshake
            url = f'/api/v1/graph/compute_op/{op.id}/run'
            for approved, code in [(False, 7), (True, 0)]:
                http = client.post(url, json={'approved': approved})
                assert http.status_code == 200, http.text
                socket = _ws_call(ws, 'compute_op', str(op.id), 'run', {'approved': approved})
                left, right = http.json()['data'], socket['data']
                assert left['exit_code'] == right['exit_code'] == code
                for answer in (left, right):
                    answer.pop('duration_s')
                    answer.pop('invocation_id', None)
                assert left == right
                if approved:
                    assert left['value'] == 42 and count.read_text() == 'xx'
                else:
                    assert not count.exists()


def test_typed_list_call_validates_before_execution_over_http_and_ws(tmp_path):
    from flow_sdk.schema.data_spec.compute_op_spec import PythonOp

    manifest = tmp_path / 'agentic-assets/project_manifest/project_manifest.json'
    manifest.parent.mkdir(parents=True)
    manifest.write_text('{"ns":"transport_fixture"}')
    folder = tmp_path / 'agentic-assets/compute_op/typed-list'
    count = tmp_path / 'typed-count'
    source = (
        'from pathlib import Path\n'
        'from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\n'
        f'COUNT = Path({str(count)!r})\n'
        'def call(input, *, context):\n'
        '    COUNT.write_text((COUNT.read_text() if COUNT.exists() else "") + "x")\n'
        '    return ReturnedValue.satisfied(value=list(reversed(input)))\n'
    )
    op = ComputeOp(name='typed-list', asset_ref=str(folder), subkind='python',
                   exe_data=PythonOp(), input=['int'], output=['int'])
    with TestClient(app) as client:
        client.portal.call(op.save)
        (folder / 'call.py').write_text(source)
        with client.websocket_connect(f'/api/v1/connect/ws/{mint_uuid()}') as ws:
            ws.receive_json()
            url = f'/api/v1/graph/compute_op/{op.id}/run'
            bad = {'approved': True, 'input': ['invalid']}
            http = client.post(url, json=bad)
            assert http.status_code == 422, http.text
            socket = _ws_call(ws, 'compute_op', str(op.id), 'run', bad)
            assert socket['status'] == 'FAIL' and not count.exists()
            body = {'approved': True, 'input': [0, 2, 1]}
            http = client.post(url, json=body)
            assert http.status_code == 200, http.text
            left = http.json()['data']
            right = _ws_call(ws, 'compute_op', str(op.id), 'run', body)['data']
            assert left['value'] == right['value'] == [1, 2, 0]
            assert left['value_present'] is right['value_present'] is True
            assert left['spec_kind'] == right['spec_kind'] == 'compute.returned'
            assert left['invocation_id'] != right['invocation_id']
            assert count.read_text() == 'xx'


def test_busy_admission_keeps_legacy_http_409_and_same_ws_answer():
    from flow_sdk.builtin.agentic_process.agentic_process import release_prompt_admission, try_admit_prompt

    with TestClient(app) as client:
        created = client.post('/api/v1/graph/agentic_process', json={'worker_type': 'claude_code', 'pty_mode': False})
        assert created.status_code == 200, created.text
        pid = created.json()['data']['id']
        admission = client.portal.call(try_admit_prompt, pid)
        assert admission is not None
        try:
            with client.websocket_connect(f'/api/v1/connect/ws/{mint_uuid()}') as ws:
                ws.receive_json()
                http = client.post(f'/api/v1/graph/agentic_process/{pid}/execute', json={'instruction': 'hello'})
                assert http.status_code == 409, http.text
                socket = _ws_call(ws, 'agentic_process', pid, 'execute', {'instruction': 'hello'})
                assert socket['data'] == http.json()['data']
                assert socket['data']['exit_code'] == 1 and socket['data']['busy'] is True
                assert socket['data']['ran'] is False
        finally:
            client.portal.call(release_prompt_admission, pid, admission)


def test_block_discovery_and_scoped_names_do_not_import_python(tmp_path):
    from flow_sdk.builtin.project import Project
    from flow_sdk.schema.data_spec.compute_op_spec import PythonOp

    async def seed():
        ops = []
        for name in ('left', 'right'):
            root = tmp_path / name
            root.mkdir()
            project = Project(name=f'flowcall-{name}', fs_storage_mount_path=str(root))
            await project.save()
            folder = root / 'agentic-assets/compute_op/same-name'
            op = ComputeOp(name='same-name', project_id=project.id, asset_ref=str(folder),
                           subkind='python', exe_data=PythonOp(), input=['int'], output=['int'])
            await op.save()
            (folder / 'call.py').write_text('raise RuntimeError("discovery must not import me")\n')
            ops.append(op)
        with pytest.raises(ValueError, match='ambiguous|Ambiguous|Multiple|multiple'):
            await ComputeOp.resolve('same-name')
        for op in ops:
            assert (await ComputeOp.resolve('same-name', project=str(op.project_id))).id == op.id
            assert (await ComputeOp.resolve(str(op.typeid))).id == op.id
        return ops

    with TestClient(app) as client:
        ops = client.portal.call(seed)
        for op in ops:
            response = client.get(f'/api/v1/graph/compute_op/{op.id}')
            assert response.status_code == 200, response.text
            row = response.json()['data']
            assert row['input'] == row['output'] == ['int']
            assert row['project_id'] == str(op.project_id)


def test_concurrent_parent_calls_keep_payload_result_and_child_activity_separate(tmp_path):
    import asyncio

    from flow_sdk.schema.data_spec.compute_op_spec import PythonOp

    manifest = tmp_path / 'agentic-assets/project_manifest/project_manifest.json'
    manifest.parent.mkdir(parents=True)
    manifest.write_text('{"ns":"concurrent_fixture"}')
    output = {'number': 'int', 'invocation': 'string', 'path': 'string'}

    async def exercise():
        async def create(name, source):
            folder = tmp_path / 'agentic-assets/compute_op' / name
            op = ComputeOp(name=name, asset_ref=str(folder), subkind='python',
                           exe_data=PythonOp(), input='int', output=output)
            await op.save()
            (folder / 'call.py').write_text(source)
            return op

        child = await create('child', '''import asyncio
from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue
arrivals = 0
both = asyncio.Event()
async def call(input, *, context):
    global arrivals
    arrivals += 1
    if arrivals == 2:
        both.set()
    await both.wait()
    return ReturnedValue.satisfied(value={
        "number": input, "invocation": context.invocation_id, "path": context.parent.path,
    })
''')
        parent = await create('parent',
            'async def call(input, *, context):\n'
            f'    return await context.call({str(child.typeid)!r}, input=input, approved=True)\n')
        return await asyncio.gather(parent.call(input=11, approved=True), parent.call(input=22, approved=True))

    with TestClient(app) as client:
        left, right = client.portal.call(exercise)
        assert left.value.number == 11 and right.value.number == 22
        assert left.invocation_id == left.value.invocation
        assert right.invocation_id == right.value.invocation
        assert left.invocation_id != right.invocation_id
        assert left.value.path != right.value.path
        assert left.invocation_id in left.value.path and right.invocation_id in right.value.path
        assert '/child-' in left.value.path and '/child-' in right.value.path


def test_tagged_named_list_output_can_be_the_next_transport_input(tmp_path):
    from typing import ClassVar

    from flow_sdk.schema.data_spec import DataSpec
    from flow_sdk.schema.data_spec.compute_op_spec import PythonOp

    class Row(DataSpec):
        spec_kind: ClassVar[str] = 'test.flowcall.transport_row'
        number: int

    manifest = tmp_path / 'agentic-assets/project_manifest/project_manifest.json'
    manifest.parent.mkdir(parents=True)
    manifest.write_text('{"ns":"named_transport_fixture"}')
    folder = tmp_path / 'agentic-assets/compute_op/identity'
    op = ComputeOp(name='identity', asset_ref=str(folder), subkind='python',
                   exe_data=PythonOp(), input=[Row.spec_kind], output=[Row.spec_kind])
    with TestClient(app) as client:
        client.portal.call(op.save)
        (folder / 'call.py').write_text(
            'from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\n'
            'async def call(input, *, context): return ReturnedValue.satisfied(value=input)\n')
        url = f'/api/v1/graph/compute_op/{op.id}/run'
        first = client.post(url, json={'approved': True, 'input': [{'number': 8}]})
        assert first.status_code == 200, first.text
        value = first.json()['data']['value']
        assert value == [{'spec_kind': Row.spec_kind, 'number': 8}]
        with client.websocket_connect(f'/api/v1/connect/ws/{mint_uuid()}') as ws:
            ws.receive_json()
            second = _ws_call(ws, 'compute_op', str(op.id), 'run', {'approved': True, 'input': value})
            assert second['status'] == 'SUCCESS', second
            assert second['data']['value'] == value
