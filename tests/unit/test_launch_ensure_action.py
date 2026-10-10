"""``POST project/<id>/launch-ensure`` — the deployed-git half of a launch, per project.

A project already checked out here passes straight through (the cloud leg, where the
hub provisioned it); a missing row is mirrored from the hub and materialized in place;
a project the hub will not give this caller is a 404, never a half-made row.

Real request middleware + graph dispatcher; the hub hop and the clone are stubbed on
``Project`` so no network or git runs.
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from flow_sdk.builtin.project import Project
from tests.unit._graph_client import call_local as _call_local

pytestmark = pytest.mark.timeout(10)  # do not increase without approval


@pytest.fixture
def calls(monkeypatch):
    seen: dict[str, list] = {"hydrate": [], "setup": []}

    async def _setup(self):
        seen["setup"].append(self.id)
        return self

    monkeypatch.setattr(Project, "setup_from_git_origin", _setup)
    return seen


@pytest.mark.asyncio
async def test_a_checked_out_project_passes_through(tmp_path, monkeypatch, calls):
    project = await Project(name=str(tmp_path / "spora")).save()
    (tmp_path / "spora").mkdir(exist_ok=True)

    async def _hydrate(cls, *_a, **_k):
        calls["hydrate"].append(True)

    monkeypatch.setattr(Project, "hydrate_from_hub", classmethod(_hydrate))

    resp = await _call_local("POST", f"project/{project.id}/launch-ensure", json={})

    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["id"] == project.id
    assert calls == {"hydrate": [], "setup": []}


@pytest.mark.asyncio
async def test_a_missing_project_is_mirrored_from_the_hub_then_checked_out(tmp_path, monkeypatch, calls):
    pid = str(uuid4())

    async def _hydrate(cls, project_id, someone_typeid=None):
        calls["hydrate"].append(project_id)
        return Project(id=project_id, name="q-agent-test")

    monkeypatch.setattr(Project, "hydrate_from_hub", classmethod(_hydrate))

    resp = await _call_local("POST", f"project/{pid}/launch-ensure", json={})

    assert resp.status_code == 200, resp.text
    assert calls == {"hydrate": [pid], "setup": [pid]}


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
