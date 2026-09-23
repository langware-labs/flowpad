"""`POST /agent/<id>/deploy {"provider": "local"}` — "This computer": one more running local deployment."""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agent import Agent

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def test_each_launch_here_is_one_more_running_deployment(bootstrapped_client):
    """ "This computer" launches a process here each time: the default slot first, then "2", …"""
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint

    agent = await Agent(name=f"deploy-local-{uuid.uuid4().hex[:6]}", worker_type="claude", enabled=True).save()
    assert await agent.deployments() == []

    first = (await bootstrapped_client.post(f"/api/v1/graph/agent/{agent.id}/deploy", json={"provider": "local"})).json()
    again = (await bootstrapped_client.post(f"/api/v1/graph/agent/{agent.id}/deploy", json={"provider": "local"})).json()
    assert first["status"] == "SUCCESS" and again["status"] == "SUCCESS", (first, again)
    assert first["data"]["deployment"]["id"] != again["data"]["deployment"]["id"]
    rows = sorted(await agent.deployments(), key=lambda d: d.slot)
    assert [(d.slot, d.serving, d.is_local) for d in rows] == [("", True, True), ("2", True, True)]
    for row in rows:
        chat = await ServiceEndpoint.find_existing(str(row.typeid), "chat")
        assert chat is not None and chat.backend.type == "channel"


async def test_an_unknown_provider_is_refused_not_sent_to_the_cloud(bootstrapped_client):
    agent = await Agent(name=f"deploy-bad-{uuid.uuid4().hex[:6]}", worker_type="claude", enabled=True).save()
    answer = await bootstrapped_client.post(f"/api/v1/graph/agent/{agent.id}/deploy", json={"provider": "moon"})
    assert answer.status_code == 400 and "unknown provider" in answer.json()["message"]
    assert await agent.deployments() == []
