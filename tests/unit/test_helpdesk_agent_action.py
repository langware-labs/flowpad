"""A desk's optional agent, made from the desk's page: the agent, its source on the desk saying the side and when
it replies, and where it runs -- the support agent on a cloud machine of its own, the internal agent here; one per
side, and the hub told which one it is."""

from __future__ import annotations

import pytest

from flow_sdk.app.actions.helpdesk_agent_action import (
    DEFAULT_INSTRUCTIONS,
    create_desk_agent,
    desk_agents,
    wire_desk_agent,
)
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.project import Project
from flow_sdk.schema.data_spec.helpdesk_agent_spec import HelpdeskAgent, HelpdeskAgentSide

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

DESK = "4f9f1fd1-39b6-5465-9c20-cb4c59b08318"
#: A desk of its own per test below: the rows a test makes stay for the next.
OTHER_DESK = "5a0a2e2f-49c7-4d6e-8f31-dc5d6c1a9e42"
OWNER = "user-11111111-1111-4111-8111-111111111111"


@pytest.fixture
def deployed(monkeypatch):
    """Where each agent was started: ``("local", agent id)`` on this computer, ``(provider, agent id)`` in the cloud."""
    calls = []

    async def run_locally(self, **_kw):
        calls.append(("local", str(self.id)))

    async def deploy(self, actor, *, provider=None, main_agent=None, **_kw):
        owned = [s for s in await DataSource.find_owned(main_agent.typeid) if s.provider == "helpdesk"]
        assert owned, "its source is saved before the deploy publishes the project"
        calls.append((provider, str(main_agent.id), str(actor)))
        return {}

    monkeypatch.setattr(Agent, "run_locally", run_locally)
    monkeypatch.setattr(Project, "deploy", deploy)
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
    assert deployed == [("local", made.agent_id)], "it runs on this computer"


async def test_the_support_agent_runs_only_in_the_cloud_as_its_own_identity(deployed):
    made = await create_desk_agent(
        HelpdeskAgent(desk_project_id=OTHER_DESK, side=HelpdeskAgentSide.CUSTOMER), "Cloud", OWNER
    )

    assert deployed == [("e2b", made.agent_id, OWNER)], "deployed to a machine of its own, never run here"
    (source,) = [s for s in await DataSource.get_all({"provider": "helpdesk"}) if s.name == made.agent_name]
    assert not source.answer_place, "the machine is the one place answering: the driver's single_place"
    with pytest.raises(ValueError):
        await create_desk_agent(HelpdeskAgent(desk_project_id=OTHER_DESK, side=HelpdeskAgentSide.CUSTOMER), "Other")


async def test_the_desk_lists_its_agents_by_side(deployed):
    await create_desk_agent(
        HelpdeskAgent(desk_project_id=DESK, side=HelpdeskAgentSide.CUSTOMER, instructions="Be brief."), "Acme", OWNER
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


async def test_the_hub_is_told_which_agent_was_made_and_keeps_the_other(deployed, monkeypatch):
    from flow_sdk.cloud_client.hub_proxy import HubProxy

    calls, published = [], []

    async def call(cls, method, entity_type, entity_id, action, **kw):
        calls.append((method, str(entity_type), entity_id, action, kw["payload"]))
        return {}

    async def ensure_on_hub(self, actor, **_kw):
        published.append(str(self.id))

    monkeypatch.setattr(HubProxy, "call", classmethod(call))
    monkeypatch.setattr(Agent, "ensure_on_hub", ensure_on_hub)
    support = await create_desk_agent(
        HelpdeskAgent(desk_project_id=OTHER_DESK, side=HelpdeskAgentSide.CUSTOMER), "Wired", OWNER
    )
    internal = await create_desk_agent(HelpdeskAgent(desk_project_id=OTHER_DESK, side=HelpdeskAgentSide.TEAM), "Wired")

    await wire_desk_agent(support, OWNER)
    await wire_desk_agent(internal, OWNER)

    assert calls == [
        ("POST", "project", OTHER_DESK, "helpdesk_agents", {"support_agent": support.agent_id}),
        ("POST", "project", OTHER_DESK, "helpdesk_agents", {"internal_agent": internal.agent_id}),
    ], "the side not named keeps its agent"
    assert published == [internal.agent_id], "the internal agent is published first; the deploy published the other"
