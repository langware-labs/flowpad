"""Pins for the default flow's one completion (`oauth_action.complete_hub_flow`).

The hub's return to `/auth/oauth/complete`, its `oauth_msg` push and the
`wait-callback` poll all finish a hub flow through it.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from flow_sdk.app.actions import oauth_action
from flow_sdk.core.oauth import flows
from flow_sdk.core.oauth.flows import AuthFlowKind, AuthFlowStatus

pytestmark = pytest.mark.asyncio


class _Socket:
    def __init__(self):
        self.sent: list[dict] = []

    async def send_text(self, message: str) -> None:
        self.sent.append(json.loads(message))


@pytest.fixture(autouse=True)
def hub(monkeypatch):
    import flow_sdk.core.oauth.hub_oauth as hub_oauth
    import flow_sdk.server.routes.websocket as websocket

    monkeypatch.setattr(flows, "_flows", flows.OrderedDict())
    monkeypatch.setattr(websocket, "_active_connections", {})
    state = {"status": "success", "waits": 0, "adopted": [], "adopt_error": None}

    async def wait(provider, flow_id):
        state["waits"] += 1
        return {"status": state["status"]}

    async def credentials_name(provider):
        return f"{provider}_credentials"

    async def adopt(provider, local_name, hub_name):
        if state["adopt_error"]:
            raise state["adopt_error"]
        state["adopted"].append(provider)

    monkeypatch.setattr(hub_oauth, "hub_wait_auth", wait)
    monkeypatch.setattr(hub_oauth, "hub_credentials_ref", credentials_name)
    monkeypatch.setattr(oauth_action, "resolve_user_credentials_name", credentials_name)
    monkeypatch.setattr(oauth_action, "_adopt_hub_credential", adopt)
    state["websocket"] = websocket
    return state


def _tab(hub, connection_id: str) -> _Socket:
    socket = _Socket()
    websocket = hub["websocket"]
    websocket._active_connections[connection_id] = websocket.ConnectionInfo(ws=socket, is_tab=True)
    return socket


async def test_racing_completions_store_the_local_copy_once(hub):
    flow = flows.start_flow(AuthFlowKind.HUB_CODE, "slack")

    results = await asyncio.gather(*(oauth_action.complete_hub_flow("slack", flow.flow_id) for _ in range(3)))

    assert hub["adopted"] == ["slack"]
    assert {result.status for result, _ in results} == {AuthFlowStatus.SUCCESS}


async def test_a_hub_still_waiting_leaves_the_flow_open(hub):
    hub["status"] = "pending"
    flow = flows.start_flow(AuthFlowKind.HUB_CODE, "slack")

    assert await oauth_action.complete_hub_flow("slack", flow.flow_id) == (None, False)
    assert flows.get_flow(flow.flow_id).result is None


async def test_the_landing_only_closes_when_the_initiating_tab_was_told(hub):
    from flow_sdk.server.routes.auth import oauth_complete

    tab = _tab(hub, "tab-a")
    told = flows.start_flow(AuthFlowKind.HUB_CODE, "slack", initiator_connection_id="tab-a")
    orphan = flows.start_flow(AuthFlowKind.HUB_CODE, "linear", initiator_connection_id="closed-tab")

    assert "window.close()" in (await oauth_complete(state=told.flow_id, provider="")).body.decode()
    assert "linear connected" in (await oauth_complete(state=orphan.flow_id, provider="")).body.decode()
    assert [m["status"] for m in tab.sent] == ["success"]


async def test_a_failed_local_store_tells_the_initiator(hub):
    from flow_sdk.server.routes.auth import oauth_complete

    hub["adopt_error"] = RuntimeError("could not store")
    tab = _tab(hub, "tab-a")
    flow = flows.start_flow(AuthFlowKind.HUB_CODE, "slack", initiator_connection_id="tab-a")

    response = await oauth_complete(state=flow.flow_id, provider="")

    assert [m["status"] for m in tab.sent] == ["error"]
    assert "window.close()" in response.body.decode()


async def test_the_hub_push_completes_only_hub_flows(hub):
    from flow_sdk.cloud_client.hub_bridge import HubWsBridge

    hub_flow = flows.start_flow(AuthFlowKind.HUB_CODE, "slack")
    local_flow = flows.start_flow(AuthFlowKind.LOOPBACK, "anthropic")
    bridge = HubWsBridge()

    await bridge._on_oauth_msg({"oauth_request_id": local_flow.flow_id})
    await bridge._on_oauth_msg({"oauth_request_id": hub_flow.flow_id})

    assert hub["waits"] == 1 and hub["adopted"] == ["slack"]
    assert flows.get_flow(local_flow.flow_id).result is None
