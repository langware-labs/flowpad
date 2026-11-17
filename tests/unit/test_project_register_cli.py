"""``flow project register <dir>`` answers the folder's project, and creates one only when there is none."""
from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import _common, project_cmd
from flow_sdk.fs_store.path_utils import canonical_posix_path


class _Response:
    status_code = 200

    def __init__(self, data):
        self._body = {"status": "SUCCESS", "data": data}

    def json(self) -> dict:
        return self._body


@pytest.mark.parametrize("existing", [[], [{"id": "already-there"}]])
def test_register_answers_the_folders_project_or_creates_it(monkeypatch, tmp_path, existing):
    posted = []
    monkeypatch.setattr(_common, "discover_port", lambda **_kw: 1234)

    def request(method, url, **kw):
        if method == "GET":
            return _Response(existing)
        posted.append((url, kw["json"]))
        return _Response({"id": "new-project"})

    monkeypatch.setattr(_common, "local_request", request)
    result = CliRunner().invoke(project_cmd.project_app, ["register", str(tmp_path)])

    assert result.exit_code == 0, result.output
    out = json.loads(result.output.splitlines()[-1])
    if existing:
        assert out["project_id"] == "already-there" and posted == []
    else:
        assert out["project_id"] == "new-project"
        assert posted == [("http://127.0.0.1:1234/api/v1/graph/project", {
            "type": "project", "name": tmp_path.name, "fs_storage_mount_path": canonical_posix_path(str(tmp_path)),
        })]
