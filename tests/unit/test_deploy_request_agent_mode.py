"""The deploy dialog's Agent mode reaches the hub: the desktop's ``deploy`` takes the fields and passes them on.

Before this the desktop's ``DeployRequest`` forbade them, so Launch in Private mode answered 400 and never deployed.
"""

import pytest
from pydantic import ValidationError

from flow_sdk.builtin.agent_cloud_deploy import DeployRequest


def test_private_mode_fields_are_taken_and_passed_on():
    body = DeployRequest(
        provider="e2b", agent_mode="private", channels=["email", "slack", "chat_api"], idle_pause_seconds=900
    )
    assert body.mode_fields == {
        "agent_mode": "private",
        "channels": ["email", "slack", "chat_api"],
        "idle_pause_seconds": 900,
    }


def test_no_mode_sends_nothing_so_the_hub_keeps_shared():
    assert DeployRequest(provider="e2b").mode_fields == {}


def test_an_unknown_mode_or_channel_is_refused():
    with pytest.raises(ValidationError):
        DeployRequest(agent_mode="public")
    with pytest.raises(ValidationError):
        DeployRequest(agent_mode="private", channels=["fax"])


def test_a_hub_private_template_keeps_its_mode_here():
    """The desktop copies the hub's row by its fields: one it lacked was dropped, and a private template read as
    shared on every screen (its chat went to a machine a template never has)."""
    from flow_sdk.builtin.deployment import Deployment

    target = {"provider": "e2b", "scope": "s"}
    row = Deployment(
        name="x",
        target=target,
        agent_mode="private",
        channels=["email", "chat_api"],
        idle_pause_seconds=900,
        template_deployment_id=None,
        person_key=None,
    )
    assert (row.agent_mode, row.channels, row.idle_pause_seconds) == ("private", ["email", "chat_api"], 900)
    assert Deployment(name="x", target=target).agent_mode == "shared"


async def test_a_private_plan_names_no_help_desks_and_a_shared_one_still_does(monkeypatch):
    """The hub refuses desks on a private template (409): a private plan never asks; a shared plan still sends its
    list, empty included (that un-staffs the desks the agent dropped)."""
    from types import SimpleNamespace

    from flow_sdk.builtin import project as project_module
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.cloud_client.hub_proxy import HubProxy

    sent: list[dict] = []

    async def call(method, kind, entity_id, action, payload=None, **_):
        sent.append(payload)
        return {"deployment": {"id": "d"}}

    async def adopt(data, element=None):
        return SimpleNamespace(id="d")

    monkeypatch.setattr(HubProxy, "call", staticmethod(call))
    monkeypatch.setattr(Deployment, "adopt_from_hub", staticmethod(adopt))
    agent = SimpleNamespace(typeid="agent-x")

    async def none_specs():
        return []

    agent.webhook_specs, agent.hub_desks = none_specs, none_specs
    project = project_module.Project(name="p")
    await project.plan_deployment("production", provider="e2b", main_agent=agent, mode_fields={"agent_mode": "private"})
    await project.plan_deployment("production", provider="e2b", main_agent=agent)
    assert "help_desks" not in sent[0] and sent[0]["agent_mode"] == "private"
    assert sent[1]["help_desks"] == []
