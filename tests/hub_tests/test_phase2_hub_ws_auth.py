import asyncio
import json
import time
import uuid

import pytest

from flow_sdk.api.messages import APIMessage
from flow_sdk.cli.app_config import set_user
from flow_sdk.cli.auth.credentials import UserHubCredentials, load_credentials, save_credentials
from flow_sdk.cli.auth.hub_login import is_logged_in
from flow_sdk.cloud_client import ApiConfig, FlowpadClient
from flow_sdk.cloud_client.ws_client import HubWebSocketAuthError, HubWebSocketManager, connect_hub_websocket


pytestmark = pytest.mark.hub


def _config(hub_base_url: str) -> ApiConfig:
    return ApiConfig(api_base_url=f"{hub_base_url}/api/v1")


@pytest.fixture()
def capture_local_ws(monkeypatch):
    from flow_sdk.server.routes import websocket

    messages = []

    async def broadcast(message: str):
        messages.append(json.loads(message))

    monkeypatch.setattr(websocket, "broadcast", broadcast)
    return messages


async def _recv_json(websocket, timeout: float = 10.0) -> dict:
    """Receive the next JSON frame that is our reply, skipping the hub's
    opening ``ws_ready_msg`` greeting frame (hub emits it first on every
    connection — hub commit 696bf45a1)."""
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise asyncio.TimeoutError("no reply frame before timeout")
        raw = await asyncio.wait_for(websocket.recv(), timeout=remaining)
        parsed = json.loads(raw)
        if isinstance(parsed, dict) and parsed.get("message_type") == "ws_ready_msg":
            continue
        return parsed


@pytest.mark.asyncio
async def test_hub_ws_rest_current_user_matches_rest_current_user(hub_base_url, hub_login_payload):
    creds = UserHubCredentials.from_login_payload(hub_login_payload)
    save_credentials(creds)
    set_user(creds.user)

    async with FlowpadClient(_config(hub_base_url)) as client:
        rest_user = await client.get_user()

    async with connect_hub_websocket(_config(hub_base_url), connection_id=str(uuid.uuid4())) as websocket:
        message = APIMessage(direct_resource_type="user")
        await websocket.send(message.model_dump_json())
        ws_response = await _recv_json(websocket)

    # The hub wraps rest_api_msg replies in a response_msg envelope; unwrap
    # to the ApiResponse payload before reading status/data.
    if ws_response.get("message_type") == "response_msg":
        ws_response = ws_response.get("content") or {}

    assert str(ws_response.get("status")).lower() == "success"
    ws_users = ws_response["data"]
    assert isinstance(ws_users, list)
    assert any(user.get("id") == rest_user["id"] for user in ws_users)


@pytest.mark.asyncio
async def test_hub_ws_manager_connect_verify_and_disconnects_without_logout(hub_base_url, hub_login_payload):
    creds = UserHubCredentials.from_login_payload(hub_login_payload)
    save_credentials(creds)
    set_user(creds.user)
    manager = HubWebSocketManager(_config(hub_base_url), reconnect_initial_seconds=0.1)

    status = await manager.restart(wait_connected=True)
    assert status["hub_ws_connected"] is True

    verification = await manager.verify_current_user()
    assert verification["verified"] is True
    assert verification["local_user_id"] == creds.user["id"]
    assert manager.status_payload()["hub_ws_verified"] is True

    disconnected = await manager.stop()
    assert disconnected["hub_ws_connected"] is False
    assert is_logged_in()


@pytest.mark.asyncio
async def test_hub_ws_local_expiry_clears_credentials_and_broadcasts_auth_expired(
    hub_base_url,
    short_lived_hub_login_payload,
    capture_local_ws,
):
    creds = UserHubCredentials.from_login_payload(short_lived_hub_login_payload)
    save_credentials(creds)
    set_user(creds.user)

    await asyncio.sleep(6)

    with pytest.raises(HubWebSocketAuthError):
        async with connect_hub_websocket(_config(hub_base_url), connection_id=str(uuid.uuid4()), open_timeout=3.0):
            pass

    assert load_credentials() is None
    assert not is_logged_in()
    assert any(msg.get("message_type") == "auth_expired_msg" and msg.get("reason") == "expired" for msg in capture_local_ws)


@pytest.mark.asyncio
async def test_hub_ws_rejected_expired_token_clears_credentials_and_broadcasts_auth_expired(
    hub_base_url,
    short_lived_hub_login_payload,
    capture_local_ws,
):
    creds = UserHubCredentials.from_login_payload(short_lived_hub_login_payload)
    creds.expires_at = None
    save_credentials(creds)
    set_user(creds.user)

    await asyncio.sleep(6)

    with pytest.raises(Exception):
        async with connect_hub_websocket(_config(hub_base_url), connection_id=str(uuid.uuid4()), open_timeout=3.0):
            pass

    assert load_credentials() is None
    assert not is_logged_in()
    assert any(msg.get("message_type") == "auth_expired_msg" and msg.get("reason") == "rejected" for msg in capture_local_ws)
