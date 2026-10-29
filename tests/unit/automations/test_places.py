"""Where an automation runs (this computer, a cloud machine, the Flowpad cloud), the agent it runs,
and why the cloud's automations are missing from the list when they are."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.automations import overview as overview_mod
from flow_sdk.automations.describe import describe_then
from flow_sdk.automations.overview import agent_of, cloud_rows, overview_with_cloud, place_of
from flow_sdk.schema.data_spec.trigger_action import ActionType, TriggerAction
from flow_sdk.schema.data_spec.trigger_types import TriggerType
from tests.pytest_plugin import async_context
from tests.unit.automations._helpers import rule

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

AGENT = "agent-11111111-1111-4111-8111-111111111111"


def test_a_rule_pinned_to_no_machine_runs_on_every_machine_that_has_it():
    place = place_of(rule(TriggerType.SCHEDULE), {})
    assert place.kind == "local" and place.every_machine and place.label == "This computer"


def test_a_rule_pinned_to_this_machine_is_local():
    here = SimpleNamespace(is_local=True, name="My Mac")
    place = place_of(rule(TriggerType.SCHEDULE, runs_on="dep-here"), {"dep-here": here})
    assert place.kind == "local" and place.deployment_id == "dep-here" and not place.every_machine


def test_a_rule_pinned_to_a_cloud_machine_names_it():
    box = SimpleNamespace(is_local=False, name="gtm box")
    place = place_of(rule(TriggerType.SCHEDULE, runs_on="dep-box"), {"dep-box": box})
    assert place.kind == "cloud_machine" and place.label == "Cloud · gtm box"
    assert place.deployment_id == "dep-box" and place.deployment_name == "gtm box"


def test_a_machine_unknown_here_is_another_machine():
    place = place_of(rule(TriggerType.SCHEDULE, runs_on="dep-gone"), {})
    assert place.kind == "cloud_machine" and place.label == "Cloud · another machine"


def test_the_agent_is_the_run_agent_target_else_the_agent_the_rule_belongs_to():
    other = "agent-22222222-2222-4222-8222-222222222222"
    targeted = rule(TriggerType.SCHEDULE, parent_type_id=AGENT,
                    actions=[TriggerAction(action_type=ActionType.RUN_AGENT, target_type_id=other, prompt="go")])
    assert agent_of(targeted) == other
    assert agent_of(rule(TriggerType.SCHEDULE, parent_type_id=AGENT)) == AGENT
    assert agent_of(rule(TriggerType.SCHEDULE, parent_type_id="wizard-abc")) is None


@async_context
async def test_an_agents_own_schedule_says_which_agent_it_runs():
    """The GTM reporter's schedule read "Run an agent": its action names no target, its parent is the agent."""
    names = SimpleNamespace(name=None)

    async def name(type_id):
        return "GTM stats reporter" if type_id == AGENT else None

    names.name = name
    trigger = rule(TriggerType.SCHEDULE, parent_type_id=AGENT,
                   actions=[TriggerAction(action_type=ActionType.RUN_AGENT, prompt="send the report")])
    (part,) = await describe_then(trigger, names=names)
    assert part.text == "Run GTM stats reporter" and part.target == AGENT


@async_context
async def test_a_local_instance_never_asks_the_cloud(monkeypatch):
    monkeypatch.setattr("flow_sdk.instance_settings.privacy_mode.is_local_mode", lambda: True)
    assert await cloud_rows() == ([], None)


@async_context
async def test_signed_out_the_list_is_this_machines_and_says_why(monkeypatch):
    monkeypatch.setattr("flow_sdk.instance_settings.privacy_mode.is_local_mode", lambda: False)
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.hub_auth_available", lambda: False)
    monkeypatch.setattr(overview_mod, "_cloud_cache", None)
    rows, warning = await cloud_rows()
    assert rows == [] and warning.code == "CLOUD_SIGNED_OUT"
    rows, warning = await overview_with_cloud()
    assert warning is not None and warning.code == "CLOUD_SIGNED_OUT"
    assert all(r.source == "local" for r in rows)
