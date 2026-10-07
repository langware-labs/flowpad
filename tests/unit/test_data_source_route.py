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


def _claim(source: DataSource, **target) -> dict:
    return {"id": "c-1", "url": "https://hub/api/v1/webhook/c-1", "target": {"data_source_id": str(source.id), **target}, "watch": {}}


async def test_the_route_is_the_claim_that_delivers_here_and_names_this_computer(hub):
    source = DataSource(provider="whatsapp", name="bot")
    hub["claims"] = [_claim(DataSource(provider="whatsapp", name="other"), kind="desktop"), _claim(source, kind="desktop", instance_id="inst-1")]

    route = (await source.route_action()).data

    assert route["claim"]["id"] == "c-1" and route["current"] == "this"
    assert route["places"][0] == {"key": "this", "label": "This computer"}


async def test_moving_a_channel_to_a_cloud_placement_points_the_claim_at_its_node(hub, monkeypatch):
    from flow_sdk.builtin.agent import Agent

    agent_id = "11111111-2222-4333-8444-555555555555"
    source = DataSource(provider="whatsapp", name="bot", owner=f"agent-{agent_id}")
    hub["claims"] = [_claim(source, kind="desktop", instance_id="inst-1")]
    box = SimpleNamespace(id="dep-1", is_local=False, environment="production", target=SimpleNamespace(provider="e2b"), compute_node_id=lambda: "n-9")

    async def get_by_id(cls, ident):
        return SimpleNamespace(deployments=lambda: _done([box])) if ident == agent_id else None

    async def _done(value):
        return value

    monkeypatch.setattr(Agent, "get_by_id", classmethod(get_by_id))
    monkeypatch.setattr(DataSource, "_body", staticmethod(lambda: _done({"place": "dep-1"})))

    moved = await source.set_route_action()

    assert moved.data["current"] == "dep-1"
    ((entity, claim_id, action, body),) = hub["posted"]
    assert (entity, claim_id, action) == ("webhook", "c-1", "set_target")
    assert body == {"target": {"kind": "node", "node_typeid": "compute_node-n-9", "data_source_id": str(source.id)}}


async def test_flows_channel_is_not_moved(hub, monkeypatch):
    source = DataSource(provider="flow_whatsapp", name="flow")
    hub["claims"] = [{"id": "c-2", "target": {"kind": "placement", "agent_typeid": "agent-f"}, "watch": {"data_source_id": str(source.id)}}]

    async def body():
        return {"place": "this"}

    monkeypatch.setattr(DataSource, "_body", staticmethod(body))

    refused = await source.set_route_action()

    assert refused.status_code == 409 and hub["posted"] == []
    assert (await source.route_action()).data["current"] == "flow"
