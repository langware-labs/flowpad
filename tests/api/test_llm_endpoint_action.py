"""``llm-endpoint`` on ``compute_node/@local``: the hub's channel for pointing this
box's coding-CLI harnesses at a hub ``LLMEndpoint`` after login.

Driven over HTTP through the real app so the envelope the hub's
``call_box_action`` parses is what is asserted, not the helper's return value.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import HUB_ENDPOINT_HARNESSES

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
    assert len(data["active_for"]) == len(HUB_ENDPOINT_HARNESSES)

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
    assert "reverted" not in data, "binding no longer writes to Capability, so nothing is reverted"
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


async def test_select_lets_a_user_choose_a_source_without_a_hub(bootstrapped_client) -> None:
    """The picker's one write. It must work on a box that has never talked to a hub -- which is
    why it is a sub-action and not the bare POST, whose 409 would otherwise tell someone picking
    their own OpenRouter key that the box is not logged in."""
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability

    path = "/api/v1/graph/compute_node/@local/llm-endpoint/select"

    for payload, expected in (
        ({"harness": "claude", "kind": "api_key", "provider": "openrouter"}, ("api", "openrouter")),
        ({"harness": "claude", "kind": "device"}, ("device", None)),
    ):
        body = (await bootstrapped_client.post(path, json=payload)).json()
        assert body["status"] == "SUCCESS", body
        cap = await Capability.get_by_kind(worker_capability_kind("claude"))
        assert (cap.auth_mode, cap.api_provider) == expected, payload


async def test_select_rejects_what_it_cannot_honour(bootstrapped_client) -> None:
    path = "/api/v1/graph/compute_node/@local/llm-endpoint/select"
    for payload in (
        {"kind": "device"},  # no harness
        {"harness": "claude", "kind": "nonsense"},
        {"harness": "claude", "kind": "api_key", "provider": "nonsense"},
        {"harness": "claude", "kind": "endpoint"},  # logged out, nothing bound
    ):
        body = (await bootstrapped_client.post(path, json=payload)).json()
        assert body["status"] != "SUCCESS", f"{payload} should have been refused: {body}"


# ── test: the box's pass-through to the hub's own verdict ────────────────────────────
#
# The desktop has no other route to it. ``llm_endpoint`` is ``_api_visible=False`` -- there are
# no local rows -- so a screen calling ``/graph/llm_endpoint/<id>/test`` through dataManager
# would be asking THIS box about an entity it does not have. Hence the sub-action, beside the
# listing it already serves.

TEST_PATH = f"{PATH}/test"
VERDICT = {"ok": True, "status": 200, "model": "anthropic/claude-haiku-4.5", "latency_ms": 412, "message": ""}


@pytest.fixture
def hub_test_call(monkeypatch):
    """Capture the hub call the sub-action makes, and answer it with a verdict."""
    calls: list[tuple] = []

    async def _hub_post(entity_type, payload, entity_id=None, action=None, **kwargs):
        calls.append((entity_type, entity_id, action))
        return VERDICT

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", _hub_post)
    return calls


@pytest.mark.asyncio
@pytest.mark.parametrize("sent", ["ep1", "llm_endpoint-ep1", "llm_endpoint:ep1"])
async def test_test_forwards_to_the_hub_and_returns_the_verdict(bootstrapped_client, hub_login, hub_test_call, sent):
    """Every spelling the hub itself hands out resolves to the same bare id: the row's own
    ``id``, the typeid form in ``sources``/chain hops, and the colon form the bind payload uses.
    A caller that guessed wrong would otherwise get a 400 on a perfectly good endpoint."""
    r = await bootstrapped_client.post(TEST_PATH, json={"endpoint_typeid": sent})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "SUCCESS"
    assert body["data"] == VERDICT
    assert hub_test_call == [("llm_endpoint", "ep1", "test")]


@pytest.mark.asyncio
async def test_test_without_login_is_409(bootstrapped_client, monkeypatch, hub_test_call):
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.resolve_hub_api_key", lambda: None)
    r = await bootstrapped_client.post(TEST_PATH, json={"endpoint_typeid": "ep1"})
    assert r.json()["status"] == "FAIL"
    assert r.json().get("status_code") == 409 or r.status_code == 409
    assert hub_test_call == [], "a signed-out box must not reach the hub at all"


@pytest.mark.asyncio
async def test_test_without_an_endpoint_is_400(bootstrapped_client, hub_login, hub_test_call):
    r = await bootstrapped_client.post(TEST_PATH, json={})
    assert r.json()["status"] == "FAIL"
    assert r.json().get("status_code") == 400 or r.status_code == 400
    assert hub_test_call == []
