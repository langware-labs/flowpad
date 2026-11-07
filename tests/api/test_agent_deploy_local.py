"""`POST /project/<id>/deploy {"provider": "local", "main_agent_id"}` — "This computer": the project's one
running local deployment, answered by its main agent."""
from __future__ import annotations

import tempfile
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agent import Agent
from tests.unit.agent._seed import seed_project

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def test_launching_here_again_is_the_same_running_deployment(bootstrapped_client):
    """ "This computer" runs the project here — ONE deployment; launching it again converges on it."""
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint

    project = await seed_project(Path(tempfile.mkdtemp()) / "proj")
    agent = await Agent(
        name=f"deploy-local-{uuid.uuid4().hex[:6]}", worker_type="claude", enabled=True, project_id=str(project.id)
    ).save()
    assert await agent.deployments() == []

    body = {"provider": "local", "main_agent_id": str(agent.typeid)}
    first = (await bootstrapped_client.post(f"/api/v1/graph/project/{project.id}/deploy", json=body)).json()
    again = (await bootstrapped_client.post(f"/api/v1/graph/project/{project.id}/deploy", json=body)).json()
    assert first["status"] == "SUCCESS" and again["status"] == "SUCCESS", (first, again)
    assert first["data"]["deployment_id"] == again["data"]["deployment_id"]
    rows = await agent.deployments()
    assert [(d.serving, d.is_local, d.identity, d.parent_type_id) for d in rows] == [
        (True, True, "agent", str(project.typeid))
    ]
    chat = await ServiceEndpoint.find_existing(str(rows[0].typeid), "chat")
    assert chat is not None and chat.backend.type == "channel"
