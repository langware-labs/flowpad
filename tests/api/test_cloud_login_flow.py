"""
Tests for the cloud login/logout flow under the post-refactor /api/v1/cloud/* shape.

Endpoints covered (defined in flow_sdk/server/routes/cloud.py):
  - GET  /api/v1/cloud/status            -> {logged_in, user, cloud_url, hub_ws_*}
  - POST /api/v1/cloud/login             -> env-mode {status:"logged_in"} or browser-mode {status:"started", url}
  - POST /api/v1/cloud/logout            -> {cloud_logout_url}
  - GET  /auth/login_callback            -> success/error HTML page
  - GET  /api/v1/cloud/logout_callback   -> success HTML page
  - GET  /api/v1/graph/bootstrap         -> desktop_info.cloud_login_available

Mocked targets (existing module paths still in use after the refactor):
  - flow_sdk.cli.auth.hub_login.{is_logged_in, validate_api_key_async}
  - flow_sdk.cli.auth.credentials.{save_credentials, clear_credentials}
  - flow_sdk.cli.app_config.{get_user, set_user}
  - flow_sdk.cli.auth.cloud_login.cloud_login (the chokepoint)
  - flow_sdk.server.routes.bootstrap.is_cloud_login_available
  - flow_sdk.server.routes.websocket.broadcast (for OAuth WS messages)
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

TEST_API_KEY = "fp_production_testkey123456789abc"
USER_INFO = {"id": "user_abc123", "name": "Test User", "email": "test@example.com"}


@pytest.fixture(autouse=True)
def _no_login_escapes_this_module():
    """Restore the process's cloud-login state around every test here.

    These tests drive the real login endpoints, and a mis-aimed patch persists
    a login instead of faking one. The damage lands nowhere near here: a
    logged-in process routes `user/{id}/oauth/...` through the HUB, so twelve
    tests in three other files failed against `app.flowpad.ai` with an id that
    only exists in this file. Assertion-free on purpose — it is a net, not a
    check; the patch target is what keeps the login from happening at all.
    """
    from flow_sdk.cli import app_config

    before = app_config.get_user()
    try:
        yield
    finally:
        if app_config.get_user() != before:
            app_config.set_user(before) if before else app_config.clear_user()


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
    assert data["hub_ws_connected"] is False
    assert data["hub_ws_verified"] is False
    assert data["hub_ws_status"] in {"disconnected", "connecting", "connected", "verified", "error"}


@pytest.mark.asyncio
async def test_status_logged_out(client):
    """GET /api/v1/cloud/status returns logged_in=False when no credentials."""
    with patch("flow_sdk.cli.auth.hub_login.is_logged_in", return_value=False):
        response = await client.get("/api/v1/cloud/status")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["logged_in"] is False
    assert data["user"] is None
    assert data["hub_ws_connected"] is False


@pytest.mark.asyncio
async def test_cloud_ws_connect_requires_login(client):
    with patch("flow_sdk.cli.auth.hub_login.is_logged_in", return_value=False):
        response = await client.post("/api/v1/cloud/ws/connect")

    assert response.status_code == 401
    body = response.json()
    assert body["status"] == "FAIL"
    assert "Cloud login required" in body["message"]


@pytest.mark.asyncio
async def test_cloud_ws_connect_verifies_and_starts_manager(client):
    manager = MagicMock()
    manager.restart = AsyncMock(return_value={
        "hub_ws_connected": True,
        "hub_ws_verified": False,
        "hub_ws_status": "connected",
        "hub_ws_error": None,
    })
    manager.verify_current_user = AsyncMock(return_value={
        "verified": True,
        "local_user_id": USER_INFO["id"],
        "hub_user_id": USER_INFO["id"],
    })
    manager.status_payload.return_value = {
        "hub_ws_connected": True,
        "hub_ws_verified": True,
        "hub_ws_status": "verified",
        "hub_ws_error": None,
    }

    with (
        patch("flow_sdk.cli.auth.hub_login.is_logged_in", return_value=True),
        patch("flow_sdk.cloud_client.ws_client.hub_ws_manager", manager),
    ):
        response = await client.post("/api/v1/cloud/ws/connect")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["hub_ws_connected"] is True
    assert data["hub_ws_verified"] is True
    assert data["hub_ws_status"] == "verified"
    manager.restart.assert_awaited_once()
    manager.verify_current_user.assert_awaited_once()


@pytest.mark.asyncio
async def test_cloud_ws_disconnect_keeps_login_owner_separate(client):
    manager = MagicMock()
    manager.stop = AsyncMock(return_value={
        "hub_ws_connected": False,
        "hub_ws_verified": False,
        "hub_ws_status": "disconnected",
        "hub_ws_error": None,
    })

    with patch("flow_sdk.cloud_client.ws_client.hub_ws_manager", manager):
        response = await client.post("/api/v1/cloud/ws/disconnect")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["hub_ws_connected"] is False
    assert data["hub_ws_status"] == "disconnected"
    manager.stop.assert_awaited_once()


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
        patch("flow_sdk.cli.auth.cloud_login.save_credentials"),
        # AS USED, not at the source: `_finalize_login` imported `set_user` at
        # module load, so patching `flow_sdk.cli.app_config.set_user` leaves the
        # real one bound and the fake user is really persisted — which made the
        # PROCESS cloud-logged-in as `user_abc123` for every later test, sending
        # their hub calls to production. Same idiom as the full-flow test below.
        patch("flow_sdk.cli.auth.cloud_login.set_user"),
        patch("flow_sdk.server.routes.auth.is_secrets_enabled", return_value=True),
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
        # _finalize_login imports save_credentials/set_user at module load, so we
        # must patch the names AS USED inside cloud_login (not at the source).
        patch("flow_sdk.cli.auth.cloud_login.save_credentials") as mock_save_credentials,
        patch("flow_sdk.cli.auth.cloud_login.set_user") as mock_set_user,
        patch("flow_sdk.server.routes.auth.is_secrets_enabled", return_value=True),
    ):
        state.login_result = None
        state.login_received.clear()

        response = await client.get(
            f"/auth/login_callback?flowpad-api-key={TEST_API_KEY}"
        )

    assert response.status_code == 200
    mock_save_credentials.assert_called_once()
    saved_creds = mock_save_credentials.call_args.args[0]
    assert saved_creds.api_key == TEST_API_KEY
    assert saved_creds.expires_at is None
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
    with (
        patch(
            "flow_sdk.cli.auth.hub_login.validate_api_key_async",
            new=AsyncMock(side_effect=Exception("Invalid API key")),
        ),
        patch("flow_sdk.server.routes.auth.is_secrets_enabled", return_value=True),
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
        patch("flow_sdk.cli.auth.cloud_login.save_credentials"),
        patch("flow_sdk.cli.app_config.set_user"),
        patch("flow_sdk.server.routes.auth.is_secrets_enabled", return_value=True),
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
        patch("flow_sdk.cli.auth.cloud_login.save_credentials"),
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
async def test_bootstrap_carries_the_cloud_identity(bootstrapped_client):
    """Bootstrap says WHO this instance is signed in as, not merely that it could be.

    The sandbox identity race. A cloud sandbox is signed in by the hub over
    loopback, but its own bootstrap carried only `cloud_login_available` — a bool —
    and the local user. So the UI painted `currentUser = cloudUser ?? localUser`,
    i.e. the template's "E2B Local", and only corrected itself when an async
    `/cloud/status` landed. On a cold resume that call races a still-waking backend
    and loses, and the user is left looking at the wrong account.

    `login` here is the same block `/api/v1/cloud/status` returns, from the same
    builder — the point is that the identity arrives WITH the first paint instead
    of one round trip later.
    """
    import flow_sdk.server.routes.bootstrap as bootstrap_mod

    bootstrap_mod._bootstrap_cache = None
    user = {"id": "b0b00000-0000-4000-8000-000000000001", "type": "user", "email": "bob@local.test"}
    with (
        patch("flow_sdk.server.routes.bootstrap.is_cloud_login_available", new=AsyncMock(return_value=True)),
        patch("flow_sdk.cli.auth.hub_login.is_logged_in", return_value=True),
        patch("flow_sdk.cli.app_config.get_user", return_value=user),
    ):
        response = await bootstrapped_client.get("/api/v1/graph/bootstrap")

    assert response.status_code == 200
    payload = response.json()
    desktop_info = payload.get("data", {}).get("desktop_info") or payload.get("desktop_info")
    assert desktop_info is not None
    login = desktop_info.get("login")
    assert login is not None, f"bootstrap carries no cloud identity: {sorted(desktop_info)}"
    assert login["status"] == "logged_in"
    assert login["user"]["email"] == "bob@local.test"


@pytest.mark.asyncio
async def test_bootstrap_says_logged_out_when_it_is(bootstrapped_client):
    """The negative half — an absent identity must be stated, not omitted.

    A missing `login` block and a `logged_out` one mean different things to the
    client: the first is an old server, the second is an answer.
    """
    import flow_sdk.server.routes.bootstrap as bootstrap_mod

    bootstrap_mod._bootstrap_cache = None
    with (
        patch("flow_sdk.server.routes.bootstrap.is_cloud_login_available", new=AsyncMock(return_value=False)),
        patch("flow_sdk.cli.auth.hub_login.is_logged_in", return_value=False),
    ):
        response = await bootstrapped_client.get("/api/v1/graph/bootstrap")

    payload = response.json()
    desktop_info = payload.get("data", {}).get("desktop_info") or payload.get("desktop_info")
    login = desktop_info.get("login")
    assert login is not None
    assert login["status"] == "logged_out"
    assert login["user"] is None


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


@pytest.mark.asyncio
async def test_bootstrap_hub_outage_preserves_stored_login():
    """A transient validation failure must not turn an outage into logout."""
    from flow_sdk.server.routes.bootstrap import is_cloud_login_available

    with (
        patch("flow_sdk.cli.auth.secrets.is_secrets_enabled", return_value=True),
        patch("flow_sdk.cli.auth.hub_login.get_api_key", return_value=TEST_API_KEY),
        patch(
            "flow_sdk.cli.auth.hub_login.validate_api_key_async",
            new=AsyncMock(side_effect=ConnectionError("hub unavailable")),
        ),
        patch("flow_sdk.cli.auth.hub_login.delete_api_key") as delete_api_key,
        patch("flow_sdk.cli.app_config.set_user") as set_user,
    ):
        assert await is_cloud_login_available() is False

    delete_api_key.assert_not_called()
    set_user.assert_not_called()
