"""The desktop's ``deployment/providers`` relay: the hub's list as-is, hub-offline is explicit, hub errors pass through."""

from __future__ import annotations

from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.cloud_client.transport import hub_http

URL = "/api/v1/graph/deployment/providers"


async def test_relays_the_hubs_providers(client, monkeypatch):
    asked = []

    async def hub(entity_type, entity_id=None, action=None, *_, **__):
        asked.append((entity_type, entity_id, action))
        return ["e2b", "gcp_vm"]

    monkeypatch.setattr(hub_http, "hub_base_url", lambda: "https://hub.test")
    monkeypatch.setattr(hub_http, "hub_get_or_raise", hub)
    resp = await client.get(URL)
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"] == ["e2b", "gcp_vm"]
    assert asked == [("deployment", None, "providers")], "the hub's type-level action, no entity id"


async def test_no_hub_is_a_sign_in_409(client, monkeypatch):
    monkeypatch.setattr(hub_http, "hub_base_url", lambda: None)
    resp = await client.get(URL)
    assert resp.status_code == 409, resp.text
    assert "Sign in to the hub" in resp.json()["message"]


async def test_a_hub_refusal_keeps_its_status(client, monkeypatch):
    async def hub(*_, **__):
        raise HubError(401, "auth expired")

    monkeypatch.setattr(hub_http, "hub_base_url", lambda: "https://hub.test")
    monkeypatch.setattr(hub_http, "hub_get_or_raise", hub)
    resp = await client.get(URL)
    assert resp.status_code == 401, resp.text
