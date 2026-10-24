"""A long-lived deployment opens each new session with the agent as it is now, not as it was first read."""

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.deployment import Deployment
from tests.unit.test_asset_dependencies import _project
from tests.unit.test_deployment_source_dependencies import _agent

pytestmark = pytest.mark.timeout(15)  # do not increase timeout without approval


async def test_new_session_uses_the_agents_current_prompt_and_model(tmp_path):
    owner = await _project(tmp_path, "agent-owner")
    agent = await _agent(owner)
    agent.system_prompt = "old prompt"
    await agent.save()
    # Loaded by id, the way the runner (``agent_loop``) holds its placement for days.
    deployment = await Deployment.get_by_id((await agent.local_deployment()).id)
    before = await deployment.create_process()

    edited = await Agent.get_by_id(agent.id)  # the agent editor / REST PATCH: another copy, saved
    edited.system_prompt = "new prompt"
    edited.model = "lg"
    await edited.save()

    after = await deployment.create_process()

    assert "old prompt" in before.context_data["instructions"]
    assert "new prompt" in after.context_data["instructions"]
    assert "old prompt" not in after.context_data["instructions"]
    assert after.cli_config.get("model") == "lg"
