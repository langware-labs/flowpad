"""``GET deployment/<id>/funding`` answers what pays for the placement's turns — the hub's answer, relayed.

The desktop had no ``funding`` action, and the path parser dropped the unknown segment, so the route
answered the bare Deployment with a 200 and the deployment page never saw its funding. These drive the
real graph route in-process; the hub is faked at the transport (``HubProxy.send``), never the action.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from flow_sdk.builtin.deployment import Deployment
from flow_sdk.cloud_client.hub_proxy import HubProxy
from tests.unit._graph_client import call_local

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

HUB_FUNDING = {
    "kind": "allocation",
    "endpoint_typeid": "llm_endpoint-0b0f6c1e-3d2a-4f5b-9c8d-1e2f3a4b5c6d",
    "name": "Procurement agent allocation",
    "size": "lg",
    "model": "google/gemini-3.1-pro-preview",
    "exhausted": "",
}


@pytest.fixture
def hub(monkeypatch):
    """A signed-in hub that answers ``state.status`` / ``state.body``, recording what it was asked."""
    from flow_sdk.cli.auth import credentials
    from flow_sdk.config import default_service_config

    state = SimpleNamespace(status=200, body={"status": "SUCCESS", "data": HUB_FUNDING}, asked=[])

    async def send(method, url, **kwargs):
        state.asked.append((method, str(url)))
        return httpx.Response(state.status, json=state.body)

    monkeypatch.setattr(default_service_config, "flowpad_hub_url", "https://hub.test")
    monkeypatch.setattr(credentials, "load_credentials", lambda: SimpleNamespace(api_key="test-key"))
    monkeypatch.setattr(HubProxy, "send", staticmethod(send))
    return state


async def _placement(*, remote: bool) -> Deployment:
    row = Deployment(
        name="funding-test",
        parent_type_id="agent-7b0f6c1e-3d2a-4f5b-9c8d-1e2f3a4b5c6d",
        target={"provider": "gcp_vm" if remote else "local", "scope": "machine", "location": "sandbox"},
    )
    row.remote = remote
    await row.save()
    return row


async def test_a_hub_placement_answers_the_hubs_funding(hub):
    row = await _placement(remote=True)

    resp = await call_local("GET", f"deployment/{row.id}/funding")

    assert resp.status_code == 200, resp.text
    assert resp.json()["data"] == HUB_FUNDING
    assert hub.asked == [("GET", f"https://hub.test/api/v1/graph/deployment/{row.id}/funding")]


async def test_a_silent_hub_is_a_502(hub):
    hub.status = 500
    row = await _placement(remote=True)

    resp = await call_local("GET", f"deployment/{row.id}/funding")

    assert resp.status_code == 502, resp.text
    assert "the hub did not answer" in resp.json()["message"]


async def test_signed_out_is_a_409(hub, monkeypatch):
    from flow_sdk.config import default_service_config

    monkeypatch.setattr(default_service_config, "flowpad_hub_url", None)
    row = await _placement(remote=True)

    resp = await call_local("GET", f"deployment/{row.id}/funding")

    assert resp.status_code == 409, resp.text
    assert hub.asked == []


async def test_a_local_placement_has_no_hub_funding_and_never_asks_the_hub(hub):
    row = await _placement(remote=False)

    resp = await call_local("GET", f"deployment/{row.id}/funding")

    assert resp.status_code == 200, resp.text
    assert resp.json()["data"] == {"kind": "none", "endpoint_typeid": "", "name": "", "exhausted": ""}
    assert hub.asked == []


async def test_an_undeclared_action_is_refused_not_answered_as_the_entity(hub):
    row = await _placement(remote=False)

    resp = await call_local("GET", f"deployment/{row.id}/no_such_action")

    assert resp.status_code == 400, resp.text
    assert "Unknown action: no_such_action" in resp.json()["message"]
