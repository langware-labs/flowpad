"""A channel's route: the hub webhook claim that delivers to it, and moving it between this computer and a
cloud placement of the agent that owns it. The hub is stood in for (``hub_get`` / ``hub_post``)."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.builtin.data_source import DataSource

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture
def hub(monkeypatch):
    from flow_sdk.cloud_client.transport import hub_http
    from flow_sdk.instance_settings import runtime

    state: dict = {"claims": [], "posted": []}

    async def hub_get(entity_type, entity_id=None, action=None, *a, **kw):
        assert (entity_type, action) == ("webhook", "mine")
        return {"webhooks": state["claims"]}

    async def hub_post(entity_type, payload, entity_id=None, action=None, *a, **kw):
        state["posted"].append((entity_type, entity_id, action, payload))
        return {"id": entity_id, "target": payload["target"]}

    monkeypatch.setattr(hub_http, "hub_get", hub_get)
    monkeypatch.setattr(hub_http, "hub_post", hub_post)
    monkeypatch.setattr(runtime, "instance_uid", lambda: "inst-1")
    return state


async def _done(value):
    return value


@pytest.fixture
def cloud_agent(monkeypatch) -> str:
    """An agent with one cloud placement (``dep-1``, on node ``n-9``), asked for ``dep-1``; its id."""
    from flow_sdk.builtin.agent import Agent

    agent_id = "11111111-2222-4333-8444-555555555555"
    box = SimpleNamespace(id="dep-1", is_local=False, environment="production", target=SimpleNamespace(provider="e2b"), compute_node_id="n-9")

    async def get_by_id(cls, ident):
        return SimpleNamespace(deployments=lambda: _done([box])) if ident == agent_id else None

    monkeypatch.setattr(Agent, "get_by_id", classmethod(get_by_id))
    monkeypatch.setattr(DataSource, "_body", staticmethod(lambda: _done({"place": "dep-1"})))
    return agent_id


def _claim(source: DataSource, **target) -> dict:
    return {"id": "c-1", "url": "https://hub/api/v1/webhook/c-1", "target": {"data_source_id": str(source.id), **target}}


async def test_the_route_is_the_claim_that_delivers_here_and_names_this_computer(hub):
    source = DataSource(provider="whatsapp", name="bot")
    hub["claims"] = [_claim(DataSource(provider="whatsapp", name="other"), kind="desktop"), _claim(source, kind="desktop", instance_id="inst-1")]

    route = (await source.route_action()).data

    assert route["claim"]["id"] == "c-1" and route["current"] == "this"
    assert route["places"][0] == {"key": "this", "label": "This computer"}


async def test_moving_a_channel_to_a_cloud_placement_points_the_claim_at_its_node(hub, cloud_agent):
    source = DataSource(provider="whatsapp", name="bot", owner=f"agent-{cloud_agent}")
    hub["claims"] = [_claim(source, kind="desktop", instance_id="inst-1")]

    moved = await source.set_route_action()

    assert moved.data["current"] == "dep-1"
    ((entity, claim_id, action, body),) = hub["posted"]
    assert (entity, claim_id, action) == ("webhook", "c-1", "set_target")
    assert body == {"target": {"kind": "node", "node_typeid": "compute_node-n-9", "data_source_id": str(source.id)}}


async def test_also_delivering_to_a_cloud_placement_adds_a_second_claim_for_the_proven_sender(hub, cloud_agent):
    """The first claim stays where it is (this computer); a second one, for the same proven sender, delivers the
    same messages to the agent's box — each place answers on its own."""
    source = DataSource(provider="flow_telegram", name="tg", owner=f"agent-{cloud_agent}")
    proven = {**_claim(source, kind="desktop", instance_id="inst-1"), "provider": "telegram", "claim": {"kind": "user", "key": "665945020"}}
    hub["claims"] = [proven]

    added = await source.add_route_action()

    assert added.data["place"] == "dep-1"
    ((entity, claim_id, action, body),) = hub["posted"]
    assert (entity, claim_id, action) == ("webhook", None, "chain")
    assert body == {
        "parent": "@telegram",
        "claim": {"kind": "user", "key": "665945020"},
        "target": {"kind": "node", "node_typeid": "compute_node-n-9", "data_source_id": str(source.id)},
    }

    hub["claims"] = [proven, {**proven, "id": "c-2", "proven_at": 9e9, "target": body["target"]}]
    route = (await source.route_action()).data
    assert route["claim"]["id"] == "c-1" and route["current"] == "this", "the first claim is still the one switched"
    assert route["also"] == [{"claim_id": "c-2", "key": "dep-1", "label": "production · e2b", "node_typeid": "compute_node-n-9"}]


async def test_also_delivering_a_number_of_ones_own_adds_an_account_claim(hub, cloud_agent):
    """A WhatsApp number proven as an ACCOUNT (a Cloud API source, or a WAHA service speaking its API) gets its
    second place as an account claim too — the hub's sibling rule is per kind."""
    source = DataSource(provider="whatsapp", name="wa", owner=f"agent-{cloud_agent}")
    hub["claims"] = [{**_claim(source, kind="desktop", instance_id="inst-1"), "provider": "whatsapp",
                      "claim": {"kind": "account", "key": "972557709288"}}]

    await source.add_route_action()

    ((_entity, _claim_id, _action, body),) = hub["posted"]
    assert body["claim"] == {"kind": "account", "key": "972557709288"} and "proof" not in body
