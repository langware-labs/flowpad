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
