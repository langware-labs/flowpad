"""``llm-endpoint`` on ``compute_node/@local``: the hub's channel for pointing this
box's coding-CLI harnesses at a hub ``LLMEndpoint`` after login.

Driven over HTTP through the real app so the envelope the hub's
``call_box_action`` parses is what is asserted, not the helper's return value.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PATH = "/api/v1/graph/compute_node/@local/llm-endpoint"
INVOKE_PATH = "/api/v1/graph/llm_endpoint/ep1/invoke"
BIND = {"endpoint_typeid": "llm_endpoint:ep1", "invoke_path": INVOKE_PATH, "provider": "openrouter", "name": "OR"}


@pytest.fixture
def hub_login(monkeypatch):
    """A box the hub has logged in: ``resolve_hub_api_key`` answers with a key.
    Patched at the resolver, not the store, because the API suite's instance
    settings are process-cached and must not be reset under other tests."""
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.resolve_hub_api_key", lambda: "fp-hub-key")
    yield


@pytest.fixture(autouse=True)
async def _clean_binding():
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import unbind_hub_llm_endpoint
    from flow_sdk.instance_settings import llm_endpoint

    llm_endpoint.reset_cache()
    yield
    await unbind_hub_llm_endpoint()
    llm_endpoint.reset_cache()


@pytest.mark.asyncio
async def test_get_unbound(bootstrapped_client):
    r = await bootstrapped_client.get(PATH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "SUCCESS"
    assert body["data"]["endpoint_typeid"] is None
    assert body["data"]["active_for"] == []


@pytest.mark.asyncio
async def test_bind_then_get_then_unbind(bootstrapped_client, hub_login):
    r = await bootstrapped_client.post(PATH, json=BIND)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert r.json()["status"] == "SUCCESS"
    assert data["endpoint_typeid"] == "llm_endpoint:ep1"
    assert data["invoke_path"] == INVOKE_PATH
    assert data["invoke_url"].endswith(INVOKE_PATH)
    assert data["hub_logged_in"] is True
    assert len(data["active_for"]) == 3

    r = await bootstrapped_client.get(PATH)
    assert r.json()["data"]["endpoint_typeid"] == "llm_endpoint:ep1"

    # The keys list the modal renders shows the managed row as configured.
    r = await bootstrapped_client.get("/api/v1/graph/compute_node/@local/lm_keys")
    assert r.status_code == 200, r.text
    rows = [k for k in r.json()["data"] if k["provider"] == "flowpad"]
    assert rows and rows[0]["managed"] is True and rows[0]["configured"] is True

    r = await bootstrapped_client.delete(PATH)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["was_bound"] is True
    assert len(data["reverted"]) == 3
    assert data["endpoint_typeid"] is None

    r = await bootstrapped_client.get("/api/v1/graph/compute_node/@local/lm_keys")
    assert [k for k in r.json()["data"] if k["provider"] == "flowpad"] == []


@pytest.mark.asyncio
async def test_bind_without_login_is_409(bootstrapped_client, monkeypatch):
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.resolve_hub_api_key", lambda: None)
    r = await bootstrapped_client.post(PATH, json=BIND)
    body = r.json()
    assert body["status"] == "FAIL"
    assert body.get("status_code") == 409 or r.status_code == 409

    r = await bootstrapped_client.get(PATH)
    assert r.json()["data"]["endpoint_typeid"] is None


@pytest.mark.asyncio
async def test_bind_malformed_is_400(bootstrapped_client, hub_login):
    r = await bootstrapped_client.post(PATH, json={"endpoint_typeid": "llm_endpoint:ep1"})
    body = r.json()
    assert body["status"] == "FAIL"
    assert body.get("status_code") == 400 or r.status_code == 400
