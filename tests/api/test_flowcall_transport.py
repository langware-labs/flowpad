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
                left.pop('duration_s'); right.pop('duration_s')
                assert left == right
                if approved:
                    assert left['value'] == 42 and count.read_text() == 'xx'
                else:
                    assert not count.exists()


def test_busy_admission_keeps_legacy_http_409_and_same_ws_answer():
    from flow_sdk.builtin.agentic_process.agentic_process import try_admit_prompt, release_prompt_admission

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
