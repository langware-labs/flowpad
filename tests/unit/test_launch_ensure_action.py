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
