"""``POST project/<id>/launch-ensure`` — the deployed-git half of a launch, per project.

A project already checked out here passes straight through (the cloud leg, where the
hub provisioned it); a missing row is mirrored from the hub and materialized in place;
a project the hub will not give this caller is a 404, never a half-made row.

Real request middleware + graph dispatcher; the hub hop and the clone are stubbed on
``Project`` so no network or git runs.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from flow_sdk.builtin.project import Project
from tests.unit._graph_client import call_local as _call_local

pytestmark = pytest.mark.timeout(10)  # do not increase without approval


@pytest.fixture
def calls(monkeypatch):
    seen: dict[str, list] = {"hydrate": [], "setup": [], "index": []}

    async def _index(path, **kwargs):
        seen["index"].append((path, kwargs.get("strict")))

    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process._index_additional_dir", _index)

    async def _setup(self):
        seen["setup"].append(self.id)
        return self

    monkeypatch.setattr(Project, "setup_from_git_origin", _setup)
    return seen


@pytest.mark.asyncio
async def test_a_checked_out_project_passes_through(tmp_path, monkeypatch, calls):
    project = await Project(name=str(tmp_path / "acme")).save()
    (tmp_path / "acme").mkdir(exist_ok=True)

    async def _hydrate(cls, *_a, **_k):
        calls["hydrate"].append(True)

    monkeypatch.setattr(Project, "hydrate_from_hub", classmethod(_hydrate))

    resp = await _call_local("POST", f"project/{project.id}/launch-ensure", json={})

    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["id"] == project.id
    # Nothing is fetched again, but its contents are made sure of: an earlier try's index may not
    # have finished, and a project whose agents are not rows cannot be launched.
    assert calls["hydrate"] == [] and calls["setup"] == []
    assert calls["index"] == [(project.fs_storage_mount_path, True)]


@pytest.mark.asyncio
async def test_a_missing_project_is_mirrored_from_the_hub_then_checked_out(tmp_path, monkeypatch, calls):
    pid = str(uuid4())

    async def _hydrate(cls, project_id, someone_typeid=None):
        calls["hydrate"].append(project_id)
        return Project(id=project_id, name="q-agent-test")

    monkeypatch.setattr(Project, "hydrate_from_hub", classmethod(_hydrate))

    resp = await _call_local("POST", f"project/{pid}/launch-ensure", json={})

    assert resp.status_code == 200, resp.text
    assert calls["hydrate"] == [pid] and calls["setup"] == [pid]


@pytest.mark.asyncio
async def test_a_project_the_hub_refuses_is_a_404(monkeypatch, calls):
    async def _hydrate(cls, *_a, **_k):
        return None

    monkeypatch.setattr(Project, "hydrate_from_hub", classmethod(_hydrate))

    resp = await _call_local("POST", f"project/{uuid4()}/launch-ensure", json={})

    assert resp.status_code == 404, resp.text
    assert calls["setup"] == []


@pytest.mark.parametrize(
    ("status", "says"),
    [(0, "Couldn't reach the cloud"), (401, "sign-in on this machine has expired"), (500, "boom")],
)
@pytest.mark.asyncio
async def test_a_hub_that_cannot_be_asked_says_why(monkeypatch, calls, status, says):
    from flow_sdk.cloud_client.shared.errors import HubError

    async def _hydrate(cls, *_a, **_k):
        raise HubError(status, "boom")

    monkeypatch.setattr(Project, "hydrate_from_hub", classmethod(_hydrate))

    resp = await _call_local("POST", f"project/{uuid4()}/launch-ensure", json={})

    assert resp.status_code == 404, resp.text
    assert says in resp.json()["message"]
    assert calls["setup"] == []


@pytest.mark.asyncio
async def test_a_checkout_that_fails_carries_gits_own_words(monkeypatch):
    from flow_sdk.assets.git_publish import AssetPublishCode, AssetPublishError

    async def _hydrate(cls, project_id, someone_typeid=None):
        return Project(id=project_id, name="q-agent-test")

    async def _setup(self):
        raise AssetPublishError(
            AssetPublishCode.HUB_PUBLISH_FAILED, "git clone against the hub failed", data={"detail": "repository not found"}
        )

    monkeypatch.setattr(Project, "hydrate_from_hub", classmethod(_hydrate))
    monkeypatch.setattr(Project, "setup_from_git_origin", _setup)

    resp = await _call_local("POST", f"project/{uuid4()}/launch-ensure", json={})

    assert resp.status_code == 400, resp.text
    assert resp.json()["message"] == "Couldn't set up the project: git clone against the hub failed — repository not found"


@pytest.mark.asyncio
async def test_a_checked_out_project_that_cannot_be_indexed_says_so(tmp_path, monkeypatch, calls):
    project = await Project(name=str(tmp_path / "q")).save()
    (tmp_path / "q").mkdir(exist_ok=True)

    async def _index(path, **kwargs):
        raise RuntimeError("Context indexing reported 2 error(s)")

    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process._index_additional_dir", _index)

    resp = await _call_local("POST", f"project/{project.id}/launch-ensure", json={})

    assert resp.status_code == 400, resp.text
    assert "indexing reported 2 error(s)" in resp.json()["message"]


@pytest.mark.asyncio
async def test_a_launch_waits_its_turn_behind_an_index_already_running(tmp_path, monkeypatch, calls):
    """On a new install the boot-time index is still running when a launch link arrives. The
    launch takes the machine's one index slot in turn rather than indexing beside it."""
    from contextlib import asynccontextmanager

    from flow_sdk.app.actions import launch_action

    order: list[str] = []

    class Node:
        @asynccontextmanager
        async def index_turn(self):
            order.append("turn taken")
            try:
                yield None, None
            finally:
                order.append("turn released")

    async def _get_local(cls, **_kwargs):
        return Node()

    async def _ensure(project_id, someone_typeid=None):
        order.append("ensure")
        return Project(id=project_id, name="acme")

    monkeypatch.setattr(launch_action.ComputeNode, "get_local", classmethod(_get_local))
    monkeypatch.setattr(launch_action, "ensure_launched_project", _ensure)

    resp = await _call_local("POST", f"project/{uuid4()}/launch-ensure", json={})

    assert resp.status_code == 200, resp.text
    assert order == ["turn taken", "ensure", "turn released"]


@pytest.mark.asyncio
async def test_a_launched_projects_assets_are_the_projects_own(tmp_path, monkeypatch):
    """The checkout is the project's OWN folder: what it declares is project content. Indexed as the
    user's, its credentials vanished from the project's setup (nothing asked, nothing injected)."""
    import json

    from flow_sdk.builtin import project_setup
    from flow_sdk.builtin.credential_status import credentials_status

    root = tmp_path / "acme"
    pack = root / "agentic-assets" / "credential" / "google-cloud"
    pack.mkdir(parents=True)
    (pack / "credential.json").write_text(json.dumps({"name": "google-cloud", "schema": 2, "vars": {"GCP_KEY": {}}}))
    (pack / "setup.md").write_text("Create a key.")
    project = await Project(name=f"launched-{uuid4().hex[:8]}", fs_storage_mount_path=str(root)).save()

    resp = await _call_local("POST", f"project/{project.id}/launch-ensure", json={})

    assert resp.status_code == 200, resp.text
    rows = [r for r in (await credentials_status(project)).credentials if r.name == "google-cloud"]
    assert [(r.scope, r.project_id) for r in rows] == [("project", str(project.id))]
    readiness = await project_setup.readiness_of(project)
    assert [r.name for r in readiness.to_do] == ["google-cloud"]


@pytest.mark.asyncio
async def test_a_machine_without_git_gets_it_before_the_clone(monkeypatch, calls):
    """A fresh Windows machine has no git: the launch installs it (the shipped git-on-path op) and then
    clones, instead of failing with "install it from Flowpad's setup"."""
    import flow_sdk.app.actions.launch_action as launch
    from flow_sdk.core.wizard.runner import Resolved

    pid = str(uuid4())

    async def _hydrate(cls, project_id, someone_typeid=None):
        return Project(id=project_id, name=f"launched-{pid[:8]}")

    run_op = AsyncMock(return_value=SimpleNamespace(detail="installed"))
    monkeypatch.setattr(Project, "hydrate_from_hub", classmethod(_hydrate))
    monkeypatch.setattr(launch.sys, "platform", "win32")
    monkeypatch.setattr(launch.shutil, "which", lambda _name: None)
    monkeypatch.setattr("flow_sdk.core.wizard.execute._resolve_op",
                        AsyncMock(return_value=Resolved(SimpleNamespace(name="git-on-path"), True)))
    monkeypatch.setattr("flow_sdk.core.compute_op.runner.run_op", run_op)

    resp = await _call_local("POST", f"project/{pid}/launch-ensure", json={})

    assert resp.status_code == 200, resp.text
    assert run_op.await_args.args[0].name == "git-on-path" and calls["setup"] == [pid]
