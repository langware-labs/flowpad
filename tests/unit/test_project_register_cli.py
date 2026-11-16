"""``flow project register <dir>`` POSTs the project through the gated transport and passes the server's answer through."""
from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import _common, project_cmd
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode


class _Response:
    def __init__(self, status_code: int, body: dict):
        self.status_code, self._body = status_code, body

    def json(self) -> dict:
        return self._body


@pytest.mark.parametrize("status, body", [
    (200, {"status": "SUCCESS", "data": {"id": "new-project"}}),
    (400, {"status": "FAIL", "message": "a project named 'repo' already exists"}),
])
def test_register_posts_the_folder_and_passes_the_answer_through(monkeypatch, tmp_path, status, body):
    sent = []
    monkeypatch.setattr(_common, "discover_port", lambda **_kw: 1234)

    def request(method, url, **kw):
        sent.append((method, url, kw["json"]))
        return _Response(status, body)

    monkeypatch.setattr(_common, "local_request", request)
    result = CliRunner().invoke(project_cmd.project_app, ["register", str(tmp_path)])

    assert sent == [("POST", "http://127.0.0.1:1234/api/v1/graph/project",
                     {"type": "project", "name": tmp_path.name, "fs_storage_mount_path": str(tmp_path)})]
    out = json.loads(result.output.splitlines()[-1])
    if status == 200:
        assert result.exit_code == 0 and out["project_id"] == "new-project"
    else:
        assert result.exit_code == int(ExitCode.REFUSED) and out["error"] == body["message"]
