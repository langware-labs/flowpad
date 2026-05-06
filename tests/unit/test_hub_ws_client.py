import json
import time

import pytest

from flow_sdk.cli.app_config import clear_user, set_user
from flow_sdk.cli.auth import credentials as credentials_mod
from flow_sdk.cli.auth.credentials import UserHubCredentials, load_credentials, save_credentials
from flow_sdk.cli.auth.hub_login import is_logged_in
from flow_sdk.cloud_client import ApiConfig
from flow_sdk.cloud_client.ws_client import (
    HubWebSocketAuthError,
    HubWebSocketManager,
    build_hub_ws_url,
    connect_hub_websocket,
    hub_ws_manager,
)


@pytest.fixture()
def memory_keyring(monkeypatch):
    store: dict[tuple[str, str], str] = {}

    def get_password(service: str, name: str):
        return store.get((service, name))

    def set_password(service: str, name: str, value: str):
        store[(service, name)] = value

    def delete_password(service: str, name: str):
        try:
            del store[(service, name)]
        except KeyError:
            raise credentials_mod.keyring.errors.PasswordDeleteError("missing")

    monkeypatch.setattr(credentials_mod.keyring, "get_password", get_password)
    monkeypatch.setattr(credentials_mod.keyring, "set_password", set_password)
    monkeypatch.setattr(credentials_mod.keyring, "delete_password", delete_password)
    clear_user()
    yield store
    hub_ws_manager.request_stop()
    clear_user()


@pytest.fixture()
def capture_broadcast(monkeypatch):
    from flow_sdk.server.routes import websocket

    messages = []

    async def broadcast(message: str):
        messages.append(json.loads(message))

    monkeypatch.setattr(websocket, "broadcast", broadcast)
    return messages


def test_build_hub_ws_url_from_api_base_url():
    assert (
        build_hub_ws_url("http://127.0.0.1:8000/api/v1", "conn-1")
        == "ws://127.0.0.1:8000/api/v1/connect/ws/conn-1"
    )
    assert (
        build_hub_ws_url("https://flowpad.ai/api/v1/", "conn-2")
        == "wss://flowpad.ai/api/v1/connect/ws/conn-2"
    )


@pytest.mark.asyncio
async def test_ws_connect_without_credentials_does_not_attempt_network(monkeypatch, memory_keyring):
    import flow_sdk.cloud_client.ws_client as ws_client

    def fail_connect(*args, **kwargs):
        raise AssertionError("network should not be called without credentials")

    monkeypatch.setattr(ws_client.websockets, "connect", fail_connect)

    with pytest.raises(HubWebSocketAuthError):
        async with connect_hub_websocket(ApiConfig(api_base_url="https://hub.test/api/v1")):
            pass


@pytest.mark.asyncio
async def test_ws_pre_expired_credentials_clear_login_and_broadcast(
    monkeypatch,
    memory_keyring,
    capture_broadcast,
):
    import flow_sdk.cloud_client.ws_client as ws_client

    def fail_connect(*args, **kwargs):
        raise AssertionError("network should not be called for locally expired credentials")

    monkeypatch.setattr(ws_client.websockets, "connect", fail_connect)
    save_credentials(UserHubCredentials(api_key="expired-token", expires_at=time.time() - 10, user={"id": "u1"}))
    set_user({"id": "u1"})

    with pytest.raises(HubWebSocketAuthError):
        async with connect_hub_websocket(ApiConfig(api_base_url="https://hub.test/api/v1")):
            pass

    assert load_credentials() is None
    assert not is_logged_in()
    assert any(msg.get("message_type") == "auth_expired_msg" and msg.get("reason") == "expired" for msg in capture_broadcast)


@pytest.mark.asyncio
async def test_ws_manager_start_ignores_missing_credentials(monkeypatch, memory_keyring):
    import flow_sdk.cloud_client.ws_client as ws_client

    def fail_connect(*args, **kwargs):
        raise AssertionError("network should not be called without credentials")

    monkeypatch.setattr(ws_client.websockets, "connect", fail_connect)

    await hub_ws_manager.start()

    assert not hub_ws_manager.is_running


@pytest.mark.asyncio
async def test_ws_going_away_close_does_not_clear_login(memory_keyring, capture_broadcast):
    manager = HubWebSocketManager()
    save_credentials(UserHubCredentials(api_key="token", expires_at=time.time() + 60, user={"id": "u1"}))
    set_user({"id": "u1"})

    handled = await manager._handle_closed_connection(type("Closed", (), {"code": 1001, "reason": "going away"})())

    assert handled is False
    assert load_credentials() is not None
    assert is_logged_in()
    assert not capture_broadcast


@pytest.mark.asyncio
async def test_ws_policy_violation_close_clears_login(memory_keyring, capture_broadcast):
    manager = HubWebSocketManager()
    save_credentials(UserHubCredentials(api_key="token", expires_at=time.time() + 60, user={"id": "u1"}))
    set_user({"id": "u1"})

    handled = await manager._handle_closed_connection(type("Closed", (), {"code": 1008, "reason": "policy violation"})())

    assert handled is True
    assert load_credentials() is None
    assert not is_logged_in()
    assert any(msg.get("message_type") == "auth_expired_msg" and msg.get("reason") == "rejected" for msg in capture_broadcast)
