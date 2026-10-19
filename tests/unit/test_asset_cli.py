"""``flow asset install <typeid>`` — the shell form of one-click install.

The command owns two things: WHICH project (``--project``, else the folder it
runs in, looked up by canonical path or created) and the desk call every
install goes through (``project/<id>/install-published`` with a bare
``typeid``). The graph transport is patched at ``_common``'s seams; the desk's
behaviour is the API tests' business."""
from __future__ import annotations

import json
import uuid

from typer.testing import CliRunner

from flow_sdk.cli.commands import _common, asset_cmd
from flow_sdk.cli.flow_cli import app

TYPEID = f"skill-{uuid.uuid4()}"
PROJECT = str(uuid.uuid4())


def _wire(monkeypatch, *, projects=(), install=None):
    """Patch the transport: ``projects`` answers the filtered GET, ``install``
    (an ``on_error``-taking callable) answers the install POST."""
    calls = []
    monkeypatch.setattr(asset_cmd, "_discover_port", lambda: 6009)
    monkeypatch.setattr(_common, "get_graph_json", lambda url, *, params=None, timeout=15, on_error: (calls.append(("GET", url, params)), list(projects))[1])

    def post(url, payload, *, on_error, timeout=15):
        calls.append(("POST", url, payload))
        if url.endswith("/graph/project"):
            return {"id": PROJECT, "fs_storage_mount_path": payload["fs_storage_mount_path"]}
        if callable(install):
            return install(on_error)
        return {"id": TYPEID[-36:], "posix_path": "/p/.claude/skills/rca", "installed": {"typeid": TYPEID}}

    monkeypatch.setattr(_common, "post_graph_json", post)
    monkeypatch.setattr(asset_cmd, "_post_graph_json", post)
    return calls


def test_install_into_an_explicit_project_posts_the_bare_typeid(monkeypatch):
    calls = _wire(monkeypatch)
    result = CliRunner().invoke(app, ["asset", "install", TYPEID, "--project", PROJECT, "--overwrite"])
    assert result.exit_code == 0, result.output
    assert calls == [("POST", f"http://127.0.0.1:6009/api/v1/graph/project/{PROJECT}/install-published", {"typeid": TYPEID, "overwrite": True})]
    out = json.loads(result.stdout.strip().splitlines()[-1])
    assert (out["ok"], out["project_id"], out["id"]) == (True, PROJECT, TYPEID[-36:])


def test_the_working_directory_is_the_default_project_queried_by_path(monkeypatch, tmp_path):
    from flow_sdk.fs_store.path_utils import canonical_posix_path

    monkeypatch.chdir(tmp_path)
    calls = _wire(monkeypatch, projects=[{"id": PROJECT, "fs_storage_mount_path": canonical_posix_path(tmp_path)}])
    result = CliRunner().invoke(app, ["asset", "install", TYPEID])
    assert result.exit_code == 0, result.output
    method, _url, params = calls[0]
    assert method == "GET" and json.loads(params["filter"]) == {"fs_storage_mount_path": canonical_posix_path(tmp_path)}
    assert [c[1] for c in calls[1:]] == [f"http://127.0.0.1:6009/api/v1/graph/project/{PROJECT}/install-published"], "no project minted"


def test_a_folder_that_is_not_a_project_yet_becomes_one(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    calls = _wire(monkeypatch)
    result = CliRunner().invoke(app, ["asset", "install", TYPEID])
    assert result.exit_code == 0, result.output
    assert [c[0] for c in calls] == ["GET", "POST", "POST"]
    assert calls[1][1].endswith("/graph/project") and calls[1][2]["fs_storage_mount_path"].endswith(tmp_path.name)
    assert calls[2][1].endswith(f"/project/{PROJECT}/install-published")


def test_a_desk_refusal_is_exit_3_with_its_code(monkeypatch):
    def refuse(on_error):
        on_error(400, {"status": "FAIL", "message": "already here", "data": {"code": "exists"}})

    _wire(monkeypatch, install=refuse)
    result = CliRunner().invoke(app, ["asset", "install", TYPEID, "--project", PROJECT])
    assert result.exit_code == 3, result.output
    err = json.loads(result.stderr.strip().splitlines()[-1])
    assert (err["ok"], err["code"]) == (False, "exists")


def test_a_malformed_typeid_never_reaches_the_server(monkeypatch):
    calls = _wire(monkeypatch)
    result = CliRunner().invoke(app, ["asset", "install", "rca"])
    assert result.exit_code == 2 and calls == []
