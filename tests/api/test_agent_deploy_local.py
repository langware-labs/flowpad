"""`POST /agent/<id>/deploy {"provider": "local"}` — the one way "This computer" becomes a deployment."""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agent import Agent

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def test_deploying_here_creates_the_local_deployment_once(bootstrapped_client):
    agent = await Agent(name=f"deploy-local-{uuid.uuid4().hex[:6]}", worker_type="claude", enabled=True).save()
    assert await agent.deployments() == []

    first = (await bootstrapped_client.post(f"/api/v1/graph/agent/{agent.id}/deploy", json={"provider": "local"})).json()
    again = (await bootstrapped_client.post(f"/api/v1/graph/agent/{agent.id}/deploy", json={"provider": "local"})).json()
    assert first["status"] == "SUCCESS" and again["status"] == "SUCCESS", (first, again)
    assert first["data"]["deployment"]["id"] == again["data"]["deployment"]["id"]
    (only,) = await agent.deployments()
    assert only.is_local and only.id == first["data"]["deployment"]["id"]


async def test_an_unknown_provider_is_refused_not_sent_to_the_cloud(bootstrapped_client):
    agent = await Agent(name=f"deploy-bad-{uuid.uuid4().hex[:6]}", worker_type="claude", enabled=True).save()
    answer = await bootstrapped_client.post(f"/api/v1/graph/agent/{agent.id}/deploy", json={"provider": "moon"})
    assert answer.status_code == 400 and "unknown provider" in answer.json()["message"]
    assert await agent.deployments() == []
