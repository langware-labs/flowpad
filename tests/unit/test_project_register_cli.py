"""``flow project register <dir>`` finds the folder's project, else creates it — never a twin."""
from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import _common, project_cmd
from flow_sdk.fs_store import path_utils
from flow_sdk.fs_store.path_utils import canonical_posix_path


@pytest.mark.parametrize("existing", [[], [{"id": "already-there"}]])
def test_register_creates_once_and_reuses_the_folders_project(monkeypatch, tmp_path, existing):
    posted = []
    monkeypatch.setattr(_common, "discover_port", lambda **_kw: 1234)
    monkeypatch.setattr(_common, "get_graph_json", lambda *_a, **_kw: existing)

    def post(url, body, **_kw):
        posted.append((url, body))
        return {"id": "new-project"}

    monkeypatch.setattr(_common, "post_graph_json", post)
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


def test_a_folder_that_cannot_be_a_project_is_refused_without_a_hint_register_lacks(monkeypatch, tmp_path):
    monkeypatch.setattr(_common, "discover_port", lambda **_kw: 1234)
    monkeypatch.setattr(path_utils, "is_valid_project_cwd", lambda *_a, **_kw: False)
    result = CliRunner().invoke(project_cmd.project_app, ["register", str(tmp_path)])

    assert result.exit_code == 2
    error = json.loads(result.output.splitlines()[-1])
    assert error["error_code"] == "INVALID_CWD"
    assert error["error"].endswith("cannot be a project folder")
