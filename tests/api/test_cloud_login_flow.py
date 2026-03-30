"""
Tests for the cloud login flow:
  1. GET /api/v1/graph/oauth/flowpad_cloud/auth returns auth_url and oauth_request_id
  2. GET /post_login?flowpad-api-key=<key> stores the key and sets login state
  3. GET /api/v1/auth/status returns logged_in=True after a successful post_login
  4. GET /api/v1/graph/bootstrap returns cloud_login_available=True when logged in
  5. GET /logout clears the key, login state, and redirects to /
"""

import pytest
import pytest_asyncio
from unittest.mock import AsyncMock, patch, MagicMock


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TEST_API_KEY = "fp_production_testkey123456789abc"


def _mock_validate_ok(key: str) -> dict:
    return {"id": "user_abc123", "name": "Test User", "email": "test@example.com"}


def _mock_is_logged_in_true() -> bool:
    return True


def _mock_is_logged_in_false() -> bool:
    return False


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_flowpad_cloud_oauth_auth(bootstrapped_client):
    """GET /api/v1/graph/oauth/flowpad_cloud/auth returns an auth_url and oauth_request_id."""
    response = await bootstrapped_client.get("/api/v1/graph/oauth/flowpad_cloud/auth")
    assert response.status_code == 200
    data = response.json()["data"]
    assert "auth_url" in data, f"Expected auth_url in response: {data}"
    assert "oauth_request_id" in data, f"Expected oauth_request_id in response: {data}"
    assert "post_login" in data["auth_url"], f"Expected post_login in auth_url: {data['auth_url']}"
    assert data["provider"] == "flowpad_cloud"
    assert data["oauth_request_id"] == "flowpad_cloud"


@pytest.mark.asyncio
async def test_post_login_returns_success_html(client):
    """GET /post_login?flowpad-api-key=<key> should return a 200 success HTML page."""
    user_info = {"id": "user_abc123", "name": "Test User", "email": "test@example.com"}

    with (
        patch("flow_sdk.cli.auth.validate_api_key", return_value=user_info),
        patch("flow_sdk.cli.auth.set_api_key"),
        patch("flow_sdk.cli.app_config.set_user"),
    ):
        response = await client.get(f"/post_login?flowpad-api-key={TEST_API_KEY}")

    assert response.status_code == 200
    assert "Login Successful" in response.text


@pytest.mark.asyncio
async def test_post_login_full_flow(client):
    """Full post_login flow: validate key, store it, signal login_received."""
    from flow_sdk.server import state

    user_info = {"id": "user_abc123", "name": "Test User", "email": "test@example.com"}

    with (
        patch("flow_sdk.cli.auth.validate_api_key", return_value=user_info),
        patch("flow_sdk.cli.auth.set_api_key"),
        patch("flow_sdk.cli.app_config.set_user"),
    ):
        state.login_result = None
        state.login_received.clear()

        response = await client.get(f"/post_login?flowpad-api-key={TEST_API_KEY}")

    assert response.status_code == 200
    assert state.login_result is not None
    assert state.login_result["success"] is True
    assert state.login_result["user"]["id"] == "user_abc123"
    assert state.login_received.is_set()


@pytest.mark.asyncio
async def test_auth_status_logged_in(client):
    """GET /api/auth/status returns logged_in=True when credentials are stored."""
    user_info = {"id": "user_abc123", "name": "Test User", "email": "test@example.com"}

    with (
        patch("flow_sdk.cli.auth.is_logged_in", return_value=True),
        patch("flow_sdk.cli.app_config.get_user", return_value=user_info),
    ):
        response = await client.get("/api/v1/auth/status")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["logged_in"] is True
    assert data["user"]["id"] == "user_abc123"


@pytest.mark.asyncio
async def test_auth_status_logged_out(client):
    """GET /api/auth/status returns logged_in=False when no credentials."""
    with patch("flow_sdk.cli.auth.is_logged_in", return_value=False):
        response = await client.get("/api/v1/auth/status")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["logged_in"] is False
    assert data["user"] is None


@pytest.mark.asyncio
async def test_bootstrap_cloud_login_available(bootstrapped_client):
    """GET /api/v1/graph/bootstrap returns cloud_login_available=True when logged in."""
    import flow_sdk.server.routes.bootstrap as bootstrap_mod

    # Clear the 30-second cache so the patched is_cloud_login_available runs
    bootstrap_mod._bootstrap_cache = None

    with patch("flow_sdk.server.routes.bootstrap.is_cloud_login_available", new=AsyncMock(return_value=True)):
        response = await bootstrapped_client.get("/api/v1/graph/bootstrap")

    assert response.status_code == 200
    data = response.json()
    desktop_info = data.get("data", {}).get("desktop_info") or data.get("desktop_info")
    assert desktop_info is not None, f"desktop_info missing from bootstrap response: {list(data.keys())}"
    assert desktop_info.get("cloud_login_available") is True


@pytest.mark.asyncio
async def test_post_login_missing_key_returns_error(client):
    """GET /post_login with no flowpad-api-key param should return 400 error HTML."""
    response = await client.get("/post_login")

    assert response.status_code == 400
    assert "Login Failed" in response.text
    assert "No API key provided" in response.text


@pytest.mark.asyncio
async def test_post_login_invalid_key_returns_error(client):
    """GET /post_login with a key that fails validation should return 400 error HTML."""
    with patch("flow_sdk.cli.auth.validate_api_key", side_effect=Exception("Invalid API key")):
        response = await client.get(f"/post_login?flowpad-api-key={TEST_API_KEY}")

    assert response.status_code == 400
    assert "Login Failed" in response.text
    assert "Invalid API key" in response.text


@pytest.mark.asyncio
async def test_post_login_invalidates_bootstrap_cache(client):
    """GET /post_login clears the bootstrap cache so the next fetch reflects logged-in state."""
    import flow_sdk.server.routes.bootstrap as bootstrap_mod

    user_info = {"id": "user_abc123", "name": "Test User", "email": "test@example.com"}
    bootstrap_mod._bootstrap_cache = {"some": "stale_data"}

    with (
        patch("flow_sdk.cli.auth.validate_api_key", return_value=user_info),
        patch("flow_sdk.cli.auth.set_api_key"),
        patch("flow_sdk.cli.app_config.set_user"),
    ):
        response = await client.get(f"/post_login?flowpad-api-key={TEST_API_KEY}")

    assert response.status_code == 200
    assert bootstrap_mod._bootstrap_cache is None


@pytest.mark.asyncio
async def test_post_login_broadcasts_oauth_message(client):
    """GET /post_login broadcasts an OAuthMessage with provider=flowpad_cloud and status=success."""
    import json

    user_info = {"id": "user_abc123", "name": "Test User", "email": "test@example.com"}
    broadcast_calls = []

    async def mock_broadcast(message: str):
        broadcast_calls.append(json.loads(message))

    with (
        patch("flow_sdk.cli.auth.validate_api_key", return_value=user_info),
        patch("flow_sdk.cli.auth.set_api_key"),
        patch("flow_sdk.cli.app_config.set_user"),
        patch("flow_sdk.server.routes.websocket.broadcast", side_effect=mock_broadcast),
    ):
        response = await client.get(f"/post_login?flowpad-api-key={TEST_API_KEY}")

    assert response.status_code == 200
    assert len(broadcast_calls) == 1
    msg = broadcast_calls[0]
    assert msg["oauth_request_id"] == "flowpad_cloud"
    assert msg["status"] == "success"


@pytest.mark.asyncio
async def test_bootstrap_cloud_login_not_available(bootstrapped_client):
    """GET /api/v1/graph/bootstrap returns cloud_login_available=False when not logged in."""
    import flow_sdk.server.routes.bootstrap as bootstrap_mod

    bootstrap_mod._bootstrap_cache = None

    with patch("flow_sdk.server.routes.bootstrap.is_cloud_login_available", new=AsyncMock(return_value=False)):
        response = await bootstrapped_client.get("/api/v1/graph/bootstrap")

    assert response.status_code == 200
    data = response.json()
    desktop_info = data.get("data", {}).get("desktop_info") or data.get("desktop_info")
    assert desktop_info is not None
    assert desktop_info.get("cloud_login_available") is False


@pytest.mark.asyncio
async def test_refresh_token_returns_token(client):
    """POST /api/v1/auth/refresh-token should return a token string."""
    response = await client.post("/api/v1/auth/refresh-token")

    assert response.status_code == 200
    data = response.json()["data"]
    assert isinstance(data, str)
    assert len(data) > 0


@pytest.mark.asyncio
async def test_logout(client):
    """GET /logout clears credentials, resets login state, invalidates bootstrap cache, and redirects to /."""
    import flow_sdk.server.routes.bootstrap as bootstrap_mod
    from flow_sdk.server import state

    state.login_result = {"success": True, "user": {"id": "user_abc123"}}
    state.login_received.set()
    bootstrap_mod._bootstrap_cache = {"some": "cached_data"}

    with (
        patch("flow_sdk.cli.auth.delete_api_key"),
        patch("flow_sdk.cli.app_config.set_user"),
    ):
        response = await client.get("/api/v1/auth/logout?next=http://localhost:4097/", follow_redirects=False)

    assert response.status_code == 302
    assert response.headers["location"] == "http://localhost:4097/"
    assert state.login_result is None
    assert not state.login_received.is_set()
    assert bootstrap_mod._bootstrap_cache is None
