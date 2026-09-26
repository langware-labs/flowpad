"""On a deployment's machine the hub token read goes to the machine's own route (answered only for a
key bound to that machine, only for what the owner authorized) — never the person's value route."""
from __future__ import annotations

import pytest

from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.core.oauth import hub_oauth

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(5)]  # do not increase timeout without approval

NODE = "compute_node-2b1c7a4e-5f2d-4a83-9c11-6d4e8f0a1b23"


async def test_a_machine_asks_its_own_route_and_a_refusal_is_no_token(monkeypatch):
    asked = []

    async def hub_get(etype, eid=None, action=None, sub_path=None, **_):
        asked.append((str(etype), eid, action, sub_path))
        if sub_path == "slack_bot":
            return {"value": "xoxb-fresh"}
        raise HubError(404, "not found")

    monkeypatch.setattr("flow_sdk.instance_settings.runtime.get_assigned_compute_node", lambda: NODE)
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get", hub_get)

    assert await hub_oauth.hub_credential_value("slack_bot") == "xoxb-fresh"
    assert await hub_oauth.hub_credential_value("github_credentials") is None
    assert [a[2:] for a in asked] == [("connection-token", "slack_bot"), ("connection-token", "github_credentials")]
    assert asked[0][1] == NODE.split("-", 1)[1]
