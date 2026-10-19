"""The source picker uses scoped Project actions without changing source ownership."""
from pathlib import Path

import pytest

from flow_sdk.builtin.agent import Agent
from tests.unit.test_asset_dependencies import _layers, _project

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def _agent(project):
    agent = Agent(name="policy-reader", project_id=str(project.id),
                  asset_ref=str(Path(project.fs_storage_mount_path) / "agentic-assets" / "agent" / "policy-reader"))
    await agent.save()
    return agent


async def test_picker_preview_attach_and_remove_are_scoped(bootstrapped_client, tmp_path):
    (personal, team, company), (project, _, _) = await _layers(tmp_path)
    agent = await _agent(project)
    url = f"/api/v1/graph/project/{project.id}"
    scope = {"asset": str(agent.typeid)}
    client = bootstrapped_client
    candidates = await client.get(f"{url}/dependency-candidates", params=scope)
    assert candidates.status_code == 200
    assert set(candidates.json()["data"]["source_typeids"]) == {str(s.typeid) for s in (personal, team, company)}
    preview = await client.post(f"{url}/preview-dependencies", json={**scope, "sources": [str(personal.typeid)]})
    assert preview.status_code == 200, preview.text
    assert [s["typeid"] for s in preview.json()["data"]["dependencies"]] == [str(s.typeid) for s in (personal, team, company)]
    assert not Path(agent.asset_ref, "flow.json").exists()
    added = await client.post(f"{url}/add-dependency", json={**scope, "source": str(personal.typeid), "name": "personal"})
    assert added.status_code == 200, added.text
    assert added.json()["data"]["dependency"]["via_path"] == []
    scoped = await client.get(f"{url}/dependencies", params=scope)
    assert [s["via_path"] for s in scoped.json()["data"]["dependencies"]] == [[], ["personal"], ["personal", "team-kb"]]
    inherited = await client.post(f"{url}/remove-dependency", json={**scope, "name": "team-kb"})
    assert inherited.status_code == 400
    removed = await client.post(f"{url}/remove-dependency", json={**scope, "name": "personal"})
    assert removed.status_code == 200
    assert removed.json()["data"]["dependencies"] == []
    assert all(Path(source.asset_ref).is_dir() for source in (personal, team, company))


async def test_picker_refuses_an_agent_from_another_project(bootstrapped_client, tmp_path):
    (personal, _, _), (project, _, _) = await _layers(tmp_path)
    other = await _project(tmp_path, "other")
    agent = await _agent(other)
    url = f"/api/v1/graph/project/{project.id}"
    scope = {"asset": str(agent.typeid)}
    response = await bootstrapped_client.get(f"{url}/dependency-candidates", params=scope)
    assert response.status_code == 400
    response = await bootstrapped_client.post(f"{url}/preview-dependencies", json={**scope, "sources": [str(personal.typeid)]})
    assert response.status_code == 400
    assert not Path(agent.asset_ref, "flow.json").exists()
