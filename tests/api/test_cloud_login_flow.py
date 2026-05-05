"""
Tests for the cloud login/logout flow under the post-refactor /api/v1/cloud/* shape.

Endpoints covered (defined in flow_sdk/server/routes/cloud.py):
  - GET  /api/v1/cloud/status            -> {logged_in, user, cloud_url}
  - POST /api/v1/cloud/login             -> env-mode {status:"logged_in"} or browser-mode {status:"started", url}
  - POST /api/v1/cloud/logout            -> {cloud_logout_url}
  - POST /api/v1/cloud/refresh-token     -> "local_dev_token_refresh" string
  - GET  /auth/login_callback            -> success/error HTML page
  - GET  /api/v1/cloud/logout_callback   -> success HTML page
  - GET  /api/v1/graph/bootstrap         -> desktop_info.cloud_login_available

Mocked targets (existing module paths still in use after the refactor):
  - flow_sdk.cli.auth.hub_login.{is_logged_in, set_api_key, validate_api_key_async, delete_api_key}
  - flow_sdk.cli.app_config.{get_user, set_user}
  - flow_sdk.cli.auth.cloud_login.cloud_login (the chokepoint)
  - flow_sdk.server.routes.bootstrap.is_cloud_login_available
  - flow_sdk.server.routes.websocket.broadcast (for OAuth WS messages)
"""

import json

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


TEST_API_KEY = "fp_production_testkey123456789abc"
USER_INFO = {"id": "user_abc123", "name": "Test User", "email": "test@example.com"}


# ---------------------------------------------------------------------------
# /api/v1/cloud/status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_logged_in(client):
    """GET /api/v1/cloud/status returns logged_in=True when credentials are stored."""
    with (
        patch("flow_sdk.cli.auth.hub_login.is_logged_in", return_value=True),
        patch("flow_sdk.cli.app_config.get_user", return_value=USER_INFO),
    ):
        response = await client.get("/api/v1/cloud/status")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["logged_in"] is True
    assert data["user"]["id"] == USER_INFO["id"]


@pytest.mark.asyncio
async def test_status_logged_out(client):
    """GET /api/v1/cloud/status returns logged_in=False when no credentials."""
    with patch("flow_sdk.cli.auth.hub_login.is_logged_in", return_value=False):
        response = await client.get("/api/v1/cloud/status")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["logged_in"] is False
    assert data["user"] is None


# ---------------------------------------------------------------------------
# POST /api/v1/cloud/login (the chokepoint)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_login_env_mode_returns_logged_in(client):
    """POST /api/v1/cloud/login returns {status: 'logged_in', user} for env-mode success."""
    with patch(
        "flow_sdk.cli.auth.cloud_login.cloud_login",
        new=AsyncMock(return_value={"status": "logged_in", "user": USER_INFO}),
    ):
        response = await client.post("/api/v1/cloud/login")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["status"] == "logged_in"
    assert data["user"]["id"] == USER_INFO["id"]


@pytest.mark.asyncio
async def test_login_browser_mode_returns_started(client):
    """POST /api/v1/cloud/login returns {status: 'started', url} for browser-mode."""
    fake_url = "https://app.flowpad.ai/login?redirect=...&callback=..."
    with patch(
        "flow_sdk.cli.auth.cloud_login.cloud_login",
        new=AsyncMock(return_value={"status": "started", "url": fake_url}),
    ):
        response = await client.post("/api/v1/cloud/login")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["status"] == "started"
    assert data["url"] == fake_url


@pytest.mark.asyncio
async def test_login_chokepoint_failure_returns_400(client):
    """POST /api/v1/cloud/login returns 400 + ApiFailResponse on synchronous failure."""
    with patch(
        "flow_sdk.cli.auth.cloud_login.cloud_login",
        new=AsyncMock(side_effect=ValueError("rejected creds")),
    ):
        response = await client.post("/api/v1/cloud/login")

    assert response.status_code == 400
    body = response.json()
    assert body["status"] == "FAIL"
    assert "rejected creds" in body["message"]


# ---------------------------------------------------------------------------
# GET /auth/login_callback (cloud redirect target)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_login_callback_returns_success_html(client):
    """GET /auth/login_callback?flowpad-api-key=<key> returns 200 with success HTML."""
    with (
        patch(
            "flow_sdk.cli.auth.hub_login.validate_api_key_async",
            new=AsyncMock(return_value=USER_INFO),
        ),
        patch("flow_sdk.cli.auth.hub_login.set_api_key"),
        patch("flow_sdk.cli.app_config.set_user"),
    ):
        response = await client.get(
            f"/auth/login_callback?flowpad-api-key={TEST_API_KEY}"
        )

    assert response.status_code == 200
    assert "Login Successful" in response.text


@pytest.mark.asyncio
async def test_login_callback_full_flow_finalizes_login(client):
    """GET /auth/login_callback validates key, persists creds, signals login_received."""
    from flow_sdk.server import state

    with (
        patch(
            "flow_sdk.cli.auth.hub_login.validate_api_key_async",
            new=AsyncMock(return_value=USER_INFO),
        ),
        # _finalize_login imports set_api_key/set_user at module load, so we
        # must patch the names AS USED inside cloud_login (not at the source).
        patch("flow_sdk.cli.auth.cloud_login.set_api_key") as mock_set_key,
        patch("flow_sdk.cli.auth.cloud_login.set_user") as mock_set_user,
    ):
        state.login_result = None
        state.login_received.clear()

        response = await client.get(
            f"/auth/login_callback?flowpad-api-key={TEST_API_KEY}"
        )

    assert response.status_code == 200
    mock_set_key.assert_called_once_with(TEST_API_KEY)
    mock_set_user.assert_called_once()
    assert state.login_result is not None
    assert state.login_result["success"] is True
    assert state.login_result["user"]["id"] == USER_INFO["id"]
    assert state.login_received.is_set()


@pytest.mark.asyncio
async def test_login_callback_missing_key_returns_400(client):
    """GET /auth/login_callback with no key returns 400 + Login Failed HTML."""
    response = await client.get("/auth/login_callback")

    assert response.status_code == 400
    assert "Login Failed" in response.text
    assert "No API key provided" in response.text


@pytest.mark.asyncio
async def test_login_callback_invalid_key_returns_400(client):
    """GET /auth/login_callback with a key that fails validation returns 400."""
    with patch(
        "flow_sdk.cli.auth.hub_login.validate_api_key_async",
        new=AsyncMock(side_effect=Exception("Invalid API key")),
    ):
        response = await client.get(
            f"/auth/login_callback?flowpad-api-key={TEST_API_KEY}"
        )

    assert response.status_code == 400
    assert "Login Failed" in response.text
    assert "Invalid API key" in response.text


@pytest.mark.asyncio
async def test_login_callback_invalidates_bootstrap_cache(client):
    """GET /auth/login_callback clears the bootstrap cache so the next fetch reflects logged-in state."""
    import flow_sdk.server.routes.bootstrap as bootstrap_mod

    bootstrap_mod._bootstrap_cache = {"some": "stale_data"}

    with (
        patch(
            "flow_sdk.cli.auth.hub_login.validate_api_key_async",
            new=AsyncMock(return_value=USER_INFO),
        ),
        patch("flow_sdk.cli.auth.hub_login.set_api_key"),
        patch("flow_sdk.cli.app_config.set_user"),
    ):
        response = await client.get(
            f"/auth/login_callback?flowpad-api-key={TEST_API_KEY}"
        )

    assert response.status_code == 200
    assert bootstrap_mod._bootstrap_cache is None


@pytest.mark.asyncio
async def test_login_callback_broadcasts_oauth_message(client):
    """GET /auth/login_callback broadcasts an OAuthMessage with provider=flowpad_cloud + status=success."""
    broadcast_calls: list[dict] = []

    async def _capture(message: str) -> None:
        broadcast_calls.append(json.loads(message))

    with (
        patch(
            "flow_sdk.cli.auth.hub_login.validate_api_key_async",
            new=AsyncMock(return_value=USER_INFO),
        ),
        patch("flow_sdk.cli.auth.cloud_login.set_api_key"),
        patch("flow_sdk.cli.auth.cloud_login.set_user"),
        patch("flow_sdk.server.routes.websocket.broadcast", side_effect=_capture),
    ):
        response = await client.get(
            f"/auth/login_callback?flowpad-api-key={TEST_API_KEY}"
        )

    assert response.status_code == 200
    # Find the OAuth-success broadcast (filter to message_type=='oauth_msg').
    oauth_msgs = [m for m in broadcast_calls if m.get("message_type") == "oauth_msg"]
    assert oauth_msgs, f"Expected an oauth_msg broadcast, got: {broadcast_calls}"
    msg = oauth_msgs[0]
    assert msg["status"] == "success"
    assert msg.get("oauth_request_id") == "flowpad_cloud"


# ---------------------------------------------------------------------------
# POST /api/v1/cloud/logout
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_logout_returns_cloud_logout_url(client):
    """POST /api/v1/cloud/logout returns {cloud_logout_url} after clearing local credentials."""
    with patch("flow_sdk.cli.auth.cloud_login.clear_cloud_credentials") as mock_clear:
        response = await client.post("/api/v1/cloud/logout")

    assert response.status_code == 200
    data = response.json()["data"]
    assert "cloud_logout_url" in data
    # logout_callback path should appear in the URL so the cloud knows where to redirect back.
    assert "logout_callback" in data["cloud_logout_url"]
    mock_clear.assert_called_once()


# ---------------------------------------------------------------------------
# GET /api/v1/cloud/logout_callback
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_logout_callback_returns_success_html(client):
    """GET /api/v1/cloud/logout_callback returns the logout-confirmation HTML."""
    with patch("flow_sdk.cli.auth.cloud_login.clear_cloud_credentials"):
        response = await client.get("/api/v1/cloud/logout_callback")

    assert response.status_code == 200
    assert "Logout Successful" in response.text
    assert "You can now close this browser page" in response.text


# ---------------------------------------------------------------------------
# POST /api/v1/cloud/refresh-token
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_refresh_token_returns_token_string(client):
    """POST /api/v1/cloud/refresh-token returns a non-empty token string (local-dev stub)."""
    response = await client.post("/api/v1/cloud/refresh-token")

    assert response.status_code == 200
    data = response.json()["data"]
    assert isinstance(data, str)
    assert len(data) > 0


# ---------------------------------------------------------------------------
# Bootstrap exposes cloud_login_available
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bootstrap_cloud_login_available_true(bootstrapped_client):
    """Bootstrap exposes desktop_info.cloud_login_available=True when the hub is reachable."""
    import flow_sdk.server.routes.bootstrap as bootstrap_mod

    bootstrap_mod._bootstrap_cache = None
    with patch(
        "flow_sdk.server.routes.bootstrap.is_cloud_login_available",
        new=AsyncMock(return_value=True),
    ):
        response = await bootstrapped_client.get("/api/v1/graph/bootstrap")

    assert response.status_code == 200
    payload = response.json()
    desktop_info = payload.get("data", {}).get("desktop_info") or payload.get("desktop_info")
    assert desktop_info is not None, f"desktop_info missing from bootstrap: {list(payload.keys())}"
    assert desktop_info.get("cloud_login_available") is True


@pytest.mark.asyncio
async def test_bootstrap_cloud_login_available_false(bootstrapped_client):
    """Bootstrap exposes desktop_info.cloud_login_available=False when the hub is unreachable."""
    import flow_sdk.server.routes.bootstrap as bootstrap_mod

    bootstrap_mod._bootstrap_cache = None
    with patch(
        "flow_sdk.server.routes.bootstrap.is_cloud_login_available",
        new=AsyncMock(return_value=False),
    ):
        response = await bootstrapped_client.get("/api/v1/graph/bootstrap")

    assert response.status_code == 200
    payload = response.json()
    desktop_info = payload.get("data", {}).get("desktop_info") or payload.get("desktop_info")
    assert desktop_info is not None
    assert desktop_info.get("cloud_login_available") is False
