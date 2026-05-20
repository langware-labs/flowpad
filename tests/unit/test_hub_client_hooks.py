import time

import httpx
import pytest

from flow_sdk.cli.app_config import clear_user, set_user
from flow_sdk.cli.auth.credentials import UserHubCredentials, load_credentials, save_credentials
from flow_sdk.cli.auth.hub_login import is_logged_in
from flow_sdk.cloud_client import ApiConfig, FlowpadClient
from flow_sdk.cloud_client.client_hooks import HubAuthExpiredError


@pytest.fixture()
def memory_keyring(sod_env):
    """Back-compat name. Phase C moved credentials off keyring into the
    per-instance sod, so the shared ``sod_env`` fixture (tests/conftest.py)
    is the right primitive. Tests reference this fixture for parameter
    injection; the yielded value (the active InstanceSettings) isn't
    inspected directly by any test in this file."""
    clear_user()
    yield sod_env
    clear_user()


@pytest.fixture()
def capture_broadcast(monkeypatch):
    from flow_sdk.server.routes import websocket

    messages = []

    async def broadcast(message: str):
        messages.append(message)

    monkeypatch.setattr(websocket, "broadcast", broadcast)
    return messages


@pytest.mark.asyncio
async def test_request_hook_injects_authorization(memory_keyring):
    seen = []

    async def handler(request: httpx.Request):
        seen.append(request)
        return httpx.Response(200, json={"data": {"id": "u1"}}, request=request)

    save_credentials(UserHubCredentials(api_key="token-1"))
    client = FlowpadClient(
        ApiConfig(api_base_url="https://hub.test/api/v1"),
        transport=httpx.MockTransport(handler),
    )

    async with client:
        user = await client.get_user()

    assert user["id"] == "u1"
    assert seen[0].headers["Authorization"] == "Bearer token-1"


@pytest.mark.asyncio
async def test_pre_expired_credentials_short_circuit_without_network(memory_keyring, capture_broadcast):
    async def handler(request: httpx.Request):
        raise AssertionError("network should not be called")

    save_credentials(UserHubCredentials(
        api_key="expired-token",
        expires_at=time.time() - 10,
        user={"id": "u1"},
    ))
    set_user({"id": "u1"})
    client = FlowpadClient(
        ApiConfig(api_base_url="https://hub.test/api/v1"),
        transport=httpx.MockTransport(handler),
    )

    async with client:
        with pytest.raises(HubAuthExpiredError):
            await client.get_user()

    assert load_credentials() is None
    assert not is_logged_in()
    assert any("auth_expired_msg" in message for message in capture_broadcast)


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [401, 402, 424])
async def test_auth_failure_status_clears_credentials_and_broadcasts_auth_expired(
    memory_keyring,
    capture_broadcast,
    status_code,
):
    async def handler(request: httpx.Request):
        return httpx.Response(status_code, json={"detail": "expired"}, request=request)

    save_credentials(UserHubCredentials(api_key="bad-token", user={"id": "u1"}))
    set_user({"id": "u1"})
    client = FlowpadClient(
        ApiConfig(api_base_url="https://hub.test/api/v1"),
        transport=httpx.MockTransport(handler),
    )

    async with client:
        with pytest.raises(ValueError):
            await client.get_user()

    assert load_credentials() is None
    assert not is_logged_in()
    assert any("auth_expired_msg" in message for message in capture_broadcast)


@pytest.mark.asyncio
async def test_current_user_fail_envelope_clears_credentials(memory_keyring, capture_broadcast):
    async def handler(request: httpx.Request):
        return httpx.Response(
            200,
            json={"status": "FAIL", "message": "400: User not found", "data": False},
            request=request,
        )

    save_credentials(UserHubCredentials(api_key="bad-token", user={"id": "u1"}))
    set_user({"id": "u1"})
    client = FlowpadClient(
        ApiConfig(api_base_url="https://hub.test/api/v1"),
        transport=httpx.MockTransport(handler),
    )

    async with client:
        with pytest.raises(ValueError):
            await client.get_user()

    assert load_credentials() is None
    assert not is_logged_in()
    assert any("auth_expired_msg" in message for message in capture_broadcast)


@pytest.mark.asyncio
async def test_500_reports_error_without_clearing_credentials(monkeypatch, memory_keyring):
    reports = []

    class Reporter:
        async def report(self, **kwargs):
            reports.append(kwargs)

    import flow_sdk.cloud_client.client_hooks as hooks

    monkeypatch.setattr(hooks, "hub_error_reporter", Reporter())

    async def handler(request: httpx.Request):
        return httpx.Response(500, json={"message": "server broke"}, request=request)

    save_credentials(UserHubCredentials(api_key="token-1", user={"id": "u1"}))
    set_user({"id": "u1"})
    client = FlowpadClient(
        ApiConfig(api_base_url="https://hub.test/api/v1"),
        transport=httpx.MockTransport(handler),
    )

    async with client:
        with pytest.raises(ValueError):
            await client.get("/broken")

    assert load_credentials().api_key == "token-1"
    assert is_logged_in()
    assert reports == [{
        "status_code": 500,
        "method": "GET",
        "path": "/api/v1/broken",
        "message": "server broke",
    }]


@pytest.mark.asyncio
async def test_non_auth_status_does_not_clear_credentials(monkeypatch, memory_keyring):
    class Reporter:
        async def report(self, **kwargs):
            pass

    import flow_sdk.cloud_client.client_hooks as hooks

    monkeypatch.setattr(hooks, "hub_error_reporter", Reporter())

    async def handler(request: httpx.Request):
        return httpx.Response(403, json={"detail": "not auth expiry"}, request=request)

    save_credentials(UserHubCredentials(api_key="token-1", user={"id": "u1"}))
    set_user({"id": "u1"})
    client = FlowpadClient(
        ApiConfig(api_base_url="https://hub.test/api/v1"),
        transport=httpx.MockTransport(handler),
    )

    async with client:
        with pytest.raises(ValueError):
            await client.get("/maybe-auth")

    assert load_credentials().api_key == "token-1"
    assert is_logged_in()
