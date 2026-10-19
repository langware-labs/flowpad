"""The local ``access`` action: an unreflected call fails loudly, and never touches the entity.

``<type>/<id>/access/public/<audience>`` is hub-only — there is no local store for a public
grant. Before ``access`` was registered locally, the path parser dropped the unknown segment
and dispatched the request as the method's implicit CRUD verb: PUT became an ``update`` of
the agent row (a fake success), and DELETE a delete of the agent itself. Each verb must now
reach the ``access`` stub and answer 409.

Real request middleware + graph dispatcher; no hub. The calls carry no ``Hub-Reflect``
header, so the local body is what runs.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.agent import Agent
from tests.unit._graph_client import call_local
from tests.unit.agent._seed import seed_agent, seed_project

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "body"),
    [("GET", None), ("PUT", {"role": "anonymous_viewer"}), ("DELETE", None)],
)
async def test_unreflected_public_access_call_is_refused_and_leaves_the_agent_alone(tmp_path: Path, method, body):
    project = await seed_project(tmp_path / "project")
    agent = await seed_agent(Path(project.fs_storage_mount_path), "public-access", project_id=project.id)

    resp = await call_local(method, f"agent/{agent.id}/access/public/visitor", json=body)

    assert resp.status_code == 409, resp.text
    assert "require Flowpad Cloud" in resp.text
    # The request must not have fallen through to the agent's own CRUD.
    still_there = await Agent.get_by_id(agent.id)
    assert still_there is not None
    assert still_there.model_dump().get("role") is None
