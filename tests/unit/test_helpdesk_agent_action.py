"""A desk's optional agent, made from the desk's page: the agent, its source on the desk saying the side and when
it replies, and its local deployment; one per side."""

from __future__ import annotations

import pytest

from flow_sdk.app.actions.helpdesk_agent_action import DEFAULT_INSTRUCTIONS, create_desk_agent, desk_agents
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.schema.data_spec.helpdesk_agent_spec import HelpdeskAgent, HelpdeskAgentSide

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

DESK = "4f9f1fd1-39b6-5465-9c20-cb4c59b08318"


@pytest.fixture
def deployed(monkeypatch):
    calls = []

    async def run_locally(self, **_kw):
        calls.append((str(self.id), str(self.project_id)))

    monkeypatch.setattr(Agent, "run_locally", run_locally)
    return calls


async def test_the_internal_agent_owns_a_source_over_the_desks_team_conversations(deployed):
    made = await create_desk_agent(
        HelpdeskAgent(desk_project_id=DESK, side=HelpdeskAgentSide.TEAM),
        "Acme Support",
    )

    agent = await Agent.get_by_id(made.agent_id)
    assert agent.name == "Acme Support team agent"
    assert agent.system_prompt == DEFAULT_INSTRUCTIONS[HelpdeskAgentSide.TEAM]
    assert agent.reply_mode == "always", "the team's notes go out whoever attends the ticket"
    (source,) = [
        s for s in await DataSource.get_all({"provider": "flow_conversation"}) if str(s.owner) == str(agent.typeid)
    ]
    assert source.config["desk_project_id"] == DESK
    assert not [s for s in await DataSource.get_all({"provider": "helpdesk"}) if str(s.owner) == str(agent.typeid)], (
        "it reads no ticket"
    )
    assert source.answer_place, "the desk is named for this deployment alone"
    assert deployed == [(made.agent_id, agent.project_id)], "it runs on this computer as its own project's agent"


async def test_the_desk_lists_its_agents_by_side(deployed):
    await create_desk_agent(
        HelpdeskAgent(desk_project_id=DESK, side=HelpdeskAgentSide.CUSTOMER, instructions="Be brief."), "Acme"
    )

    await create_desk_agent(HelpdeskAgent(desk_project_id=DESK, side=HelpdeskAgentSide.TEAM), "Acme")

    assert {a.side for a in await desk_agents(DESK)} == {HelpdeskAgentSide.CUSTOMER, HelpdeskAgentSide.TEAM}
    (listed,) = [a for a in await desk_agents(DESK) if a.side is HelpdeskAgentSide.CUSTOMER]
    assert listed.agent_name == "Acme customer agent"
    assert (await Agent.get_by_id(listed.agent_id)).reply_mode == "auto", (
        "the customer's agent goes quiet once a person attends"
    )
    assert (await Agent.get_by_id(listed.agent_id)).system_prompt == "Be brief."
    assert await desk_agents("another-desk") == []
