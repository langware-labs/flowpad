"""A deployment answers the hub conversations of the agent Identity its machine is signed in as --
and never a person's own."""

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent_serve import answered_sources, ensure_conversations_channel
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from tests.unit.agent._seed import seed_agent, seed_project

IDENTITY = str(mint_uuid())


def _sign_in(monkeypatch, principal):
    monkeypatch.setattr("flow_sdk.cli.app_config.get_principal", lambda: principal)


async def _placed_agent(tmp_path, name: str, identity: str = "agent"):
    project = await seed_project(tmp_path / name)
    agent = await seed_agent(tmp_path / name, f"{name}-agent", project_id=project.id)
    deployment = await agent.deploy("local")
    deployment.identity = identity
    return agent, deployment


async def _conversation_sources(agent) -> list:
    provider = DataDriver.loaded("conversations").provider
    return [s for s in await DataSource.find_owned(agent.typeid) if s.provider == provider]


async def test_an_agent_login_gets_one_source_answered_by_the_deployment(tmp_path, monkeypatch):
    _sign_in(monkeypatch, {"id": IDENTITY, "type": "identity", "typeid": f"identity-{IDENTITY}"})
    agent, deployment = await _placed_agent(tmp_path, "agent-login")
    source = await ensure_conversations_channel(agent, deployment)
    assert source is not None and source.owner == agent.typeid
    assert source.answer_place == deployment.id and source.config["deployment_id"] == deployment.id
    assert source.account_identities == [IDENTITY], "the loop guard knows the agent's own messages"
    assert source.id in [s.id for s in await answered_sources(agent, deployment)]
    again = await ensure_conversations_channel(agent, deployment)
    assert again.id == source.id
    assert len(await _conversation_sources(agent)) == 1


async def test_a_deployment_login_gets_a_source(tmp_path, monkeypatch):
    _sign_in(monkeypatch, {"id": IDENTITY, "type": "identity", "typeid": f"identity-{IDENTITY}"})
    agent, deployment = await _placed_agent(tmp_path, "deployment-login", identity="deployment")
    assert await ensure_conversations_channel(agent, deployment) is not None


@pytest.mark.parametrize(
    "principal",
    [None, {"id": IDENTITY, "type": "user", "typeid": f"user-{IDENTITY}"}],
    ids=["signed-out", "person"],
)
async def test_a_persons_desktop_gets_no_source(tmp_path, monkeypatch, principal):
    _sign_in(monkeypatch, principal)
    agent, deployment = await _placed_agent(tmp_path, f"person-{'in' if principal else 'out'}")
    assert await ensure_conversations_channel(agent, deployment) is None
    assert await _conversation_sources(agent) == [], "an agent must never answer a person's own conversations"


@pytest.mark.parametrize("identity", ["user", "none"])
async def test_a_deployment_that_is_not_the_agents_login_gets_no_source(tmp_path, monkeypatch, identity):
    _sign_in(monkeypatch, {"id": IDENTITY, "type": "identity", "typeid": f"identity-{IDENTITY}"})
    agent, deployment = await _placed_agent(tmp_path, f"identity-{identity}", identity=identity)
    assert await ensure_conversations_channel(agent, deployment) is None
    assert await _conversation_sources(agent) == []
