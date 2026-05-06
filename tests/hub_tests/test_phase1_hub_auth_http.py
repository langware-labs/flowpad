import asyncio
import json
import uuid

import pytest

from flow_sdk.cli.app_config import set_user
from flow_sdk.cli.auth.credentials import UserHubCredentials, load_credentials, save_credentials
from flow_sdk.cli.auth.hub_login import is_logged_in
from flow_sdk.cloud_client import ApiConfig, FlowpadClient
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.utils.hub import hub_get, hub_post, hub_put


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


@pytest.mark.asyncio
async def test_real_login_current_user_and_credentials_roundtrip(hub_base_url, hub_login_payload):
    creds = UserHubCredentials.from_login_payload(hub_login_payload)
    save_credentials(creds)
    set_user(creds.user)

    assert load_credentials().api_key == creds.api_key
    assert is_logged_in()

    async with FlowpadClient(_config(hub_base_url)) as client:
        user = await client.get_user()

    assert user["id"] == creds.user["id"]


@pytest.mark.asyncio
async def test_env_api_key_override_works_without_keyring(monkeypatch, hub_base_url, hub_login_payload):
    monkeypatch.setenv("FLOWPAD_CLOUD_API_KEY", hub_login_payload["token"])

    async with FlowpadClient(_config(hub_base_url)) as client:
        user = await client.get_user()

    assert user["id"] == hub_login_payload["user"]["id"]
    assert load_credentials() is None


@pytest.mark.asyncio
async def test_hub_helpers_use_shared_auth_for_get_post_put(hub_login_payload):
    creds = UserHubCredentials.from_login_payload(hub_login_payload)
    save_credentials(creds)
    set_user(creds.user)

    user = await hub_get(BuiltinEntityType.USER, creds.user["id"])
    assert user and user["id"] == creds.user["id"]

    task_title = f"hub-auth-test-{uuid.uuid4().hex}"
    task = await hub_post(BuiltinEntityType.TASK, {"title": task_title})
    assert task and task["title"] == task_title

    updated = await hub_put(BuiltinEntityType.TASK, task["id"], {"title": task_title, "status": "Done"})
    assert updated and updated["id"] == task["id"]
    assert updated["status"] == "Done"


@pytest.mark.asyncio
async def test_short_lived_token_expires_locally_and_clears_credentials(
    hub_base_url,
    short_lived_hub_login_payload,
    capture_local_ws,
):
    creds = UserHubCredentials.from_login_payload(short_lived_hub_login_payload)
    save_credentials(creds)
    set_user(creds.user)

    await asyncio.sleep(6)

    async with FlowpadClient(_config(hub_base_url)) as client:
        with pytest.raises(Exception):
            await client.get_user()

    assert load_credentials() is None
    assert not is_logged_in()
    assert any(msg.get("message_type") == "auth_expired_msg" and msg.get("reason") == "expired" for msg in capture_local_ws)


@pytest.mark.asyncio
async def test_hub_rejected_expired_token_clears_credentials(
    hub_base_url,
    short_lived_hub_login_payload,
    capture_local_ws,
):
    creds = UserHubCredentials.from_login_payload(short_lived_hub_login_payload)
    creds.expires_at = None
    save_credentials(creds)
    set_user(creds.user)

    await asyncio.sleep(6)

    async with FlowpadClient(_config(hub_base_url)) as client:
        with pytest.raises(Exception):
            await client.get_user()

    assert load_credentials() is None
    assert not is_logged_in()
    assert any(msg.get("message_type") == "auth_expired_msg" and msg.get("reason") == "rejected" for msg in capture_local_ws)


@pytest.mark.asyncio
async def test_invalid_key_clears_credentials(hub_base_url, capture_local_ws):
    save_credentials(UserHubCredentials(api_key="invalid-token", user={"id": "u1"}))
    set_user({"id": "u1"})

    async with FlowpadClient(_config(hub_base_url)) as client:
        with pytest.raises(Exception):
            await client.get_user()

    assert load_credentials() is None
    assert not is_logged_in()
    assert any(msg.get("message_type") == "auth_expired_msg" for msg in capture_local_ws)


@pytest.mark.asyncio
async def test_non_auth_hub_failure_reports_without_clearing_credentials(
    hub_base_url,
    hub_login_payload,
    capture_local_ws,
):
    creds = UserHubCredentials.from_login_payload(hub_login_payload)
    save_credentials(creds)
    set_user(creds.user)

    async with FlowpadClient(_config(hub_base_url)) as client:
        with pytest.raises(Exception):
            await client.get("/definitely-not-a-real-route")

    assert load_credentials().api_key == creds.api_key
    assert is_logged_in()
    assert any(msg.get("message_type") == "hub_client_error_msg" for msg in capture_local_ws)
