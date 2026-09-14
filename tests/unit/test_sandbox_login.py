"""Sandbox login keeps PKCE material on the server and binds each callback."""

import base64
import hashlib
from urllib.parse import parse_qs, urlparse

import pytest

from flow_sdk.cli.auth import sandbox_login
from flow_sdk.config import default_service_config
from flow_sdk.server import state


@pytest.fixture(autouse=True)
def isolated_login(monkeypatch):
    monkeypatch.setattr(state, "cloud_login_sessions", {})
    monkeypatch.setattr(state, "active_cloud_login_id", None)
    monkeypatch.setattr(sandbox_login, "_verifiers", {})
    monkeypatch.setattr(default_service_config, "flowpad_hub_url", "https://staging.flowpad.ai")


def test_browser_receives_only_challenge_and_registered_callback():
    result = sandbox_login.start_sandbox_login("test123")
    url = urlparse(result["url"])
    query = parse_qs(url.query)
    request_id = query["state"][0]
    verifier, callback = sandbox_login._verifiers[request_id]
    assert url.path == "/api/v1/oauth/authorize"
    assert callback == "https://9007-test123.e2b.dev/auth/oauth_callback"
    assert query["client_id"] == ["flowpad-sandbox"]
    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    assert query["code_challenge"] == [expected]
    assert verifier not in str(result)
    assert sandbox_login.start_sandbox_login("test123")["url"] == result["url"]


@pytest.mark.asyncio
async def test_unrequested_callback_cannot_exchange_or_login():
    with pytest.raises(ValueError, match="missing, expired"):
        await sandbox_login.complete_sandbox_login("unknown", "code")


@pytest.mark.asyncio
async def test_cancelled_login_cannot_redeem_code():
    result = sandbox_login.start_sandbox_login("test123")
    request_id = parse_qs(urlparse(result["url"]).query)["state"][0]
    state.cancel_cloud_login_session(request_id)
    with pytest.raises(ValueError, match="missing, expired"):
        await sandbox_login.complete_sandbox_login(request_id, "code")


@pytest.mark.asyncio
async def test_callback_exchanges_code_and_finalizes_verified_jwt(monkeypatch):
    from unittest.mock import AsyncMock
    import httpx

    result = sandbox_login.start_sandbox_login("test123")
    request_id = parse_qs(urlparse(result["url"]).query)["state"][0]
    verifier, callback = sandbox_login._verifiers[request_id]
    seen = []

    def exchange(request):
        seen.append(request)
        assert str(request.url) == "https://staging.flowpad.ai/api/v1/oauth/token"
        body = parse_qs(request.content.decode())
        assert body["code_verifier"] == [verifier]
        assert body["redirect_uri"] == [callback]
        return httpx.Response(200, json={"access_token": "verified-jwt", "expires_in": 3600})

    client = httpx.AsyncClient(transport=httpx.MockTransport(exchange))
    monkeypatch.setattr(sandbox_login.httpx, "AsyncClient", lambda: client)
    validate = AsyncMock(return_value={"id": "signed-in-user"})
    finalize = AsyncMock()
    monkeypatch.setattr(sandbox_login, "validate_api_key_async", validate)
    monkeypatch.setattr(sandbox_login, "_finalize_login", finalize)
    await sandbox_login.complete_sandbox_login(request_id, "single-use-code")
    validate.assert_awaited_once_with("verified-jwt")
    login = finalize.await_args.args[0]
    assert login.token == "verified-jwt" and login.user["id"] == "signed-in-user"
    assert state.cloud_login_session_result(request_id)["status"] == "success"
    with pytest.raises(ValueError):
        await sandbox_login.complete_sandbox_login(request_id, "single-use-code")
    assert len(seen) == 1
