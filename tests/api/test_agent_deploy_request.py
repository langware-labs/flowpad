"""`POST /agent/<id>/deploy` takes a typed body (``AgentDeployRequest``), validated by the dispatcher before the
action runs — so a bad one is a 400 and nothing is published, planned or placed."""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agent import Agent

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.mark.parametrize(
    "body, says",
    [
        ({"provider": "gcp_vm", "environment": "Not Valid"}, "not a valid environment name"),
        ({"provider": "gcp_vm", "token_allocation": {"source": "llm_endpoint-x", "model": "claude-*"}}, "one model"),
    ],
)
async def test_a_bad_deploy_body_is_refused_before_the_action_runs(bootstrapped_client, body, says):
    agent = await Agent(name=f"deploy-body-{uuid.uuid4().hex[:6]}", worker_type="claude", enabled=True).save()

    answer = await bootstrapped_client.post(f"/api/v1/graph/agent/{agent.id}/deploy", json=body)

    assert answer.status_code == 400 and says in answer.text, answer.text
    assert await agent.deployments() == []
