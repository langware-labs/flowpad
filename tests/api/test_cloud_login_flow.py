"""
Tests for the cloud login flow:
  1. GET /api/auth/login-url returns a URL pointing at app.flowpad.ai with post_login callback
  2. GET /post_login?flowpad-api-key=<key> stores the key and sets login state
  3. GET /api/auth/status returns logged_in=True after a successful post_login
  4. GET /api/v1/graph/bootstrap returns cloud_login_available=True when logged in
  5. POST /api/auth/logout clears the key and login state
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
async def test_login_url_points_to_cloud(client):
    """GET /api/auth/login-url should return a URL targeting app.flowpad.ai with post_login callback."""
    response = await client.get("/api/v1/auth/login-url")
    assert response.status_code == 200
    data = response.json()
    url = data["data"]["login_url"]
    assert "app.flowpad.ai" in url, f"Expected app.flowpad.ai in URL, got: {url}"
    assert "post_login" in url, f"Expected post_login in URL, got: {url}"


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
async def test_refresh_token_returns_token(client):
    """POST /api/v1/auth/refresh-token should return a token string."""
    response = await client.post("/api/v1/auth/refresh-token")

    assert response.status_code == 200
    data = response.json()["data"]
    assert isinstance(data, str)
    assert len(data) > 0


@pytest.mark.asyncio
async def test_logout_clears_state(client):
    """POST /api/auth/logout clears stored credentials and resets login state."""
    from flow_sdk.server import state

    state.login_result = {"success": True, "user": {"id": "user_abc123"}}
    state.login_received.set()

    with (
        patch("flow_sdk.cli.auth.delete_api_key"),
        patch("flow_sdk.cli.app_config.set_user"),
    ):
        response = await client.post("/api/v1/auth/logout")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["success"] is True
    assert state.login_result is None
    assert not state.login_received.is_set()
