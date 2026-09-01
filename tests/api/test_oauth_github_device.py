"""GitHub OAuth Device Flow tests.

Mocks GitHub's two endpoints (device_code + access_token) — no network. Walks the
full happy/sad paths through the public oauth-action surface to keep the dispatch
+ session-storage + SOD-write wiring tested end-to-end.
"""
from unittest.mock import AsyncMock, patch

import pytest
from cryptography.fernet import Fernet

from flow_sdk.app.actions import desktop_oauth as do
from flow_sdk.config import ServiceConfig, SodProvider
from flow_sdk.request_context.methods import (
    get_user_credentials,
    set_default_test_sod_driver,
)
from flow_sdk.sod.file_sod import FileSodStorage


def _device_code_response(user_code="ABCD-EFGH", interval=1, expires_in=900):
    """Mock httpx response for POST /login/device/code."""
    resp = AsyncMock()
    resp.status_code = 200
    resp.json = lambda: {
        "device_code": "DEVICE_CODE_ABC",
        "user_code": user_code,
        "verification_uri": "https://github.com/login/device",
        "expires_in": expires_in,
        "interval": interval,
    }
    return resp


def _token_response(body: dict, status_code: int = 200):
    """Mock httpx response for POST /login/oauth/access_token."""
    resp = AsyncMock()
    resp.status_code = status_code
    resp.text = str(body)
    resp.json = lambda: body
    return resp


class _FakeAsyncClient:
    """Context-manager + .post() shim for `async with httpx.AsyncClient() as client`.

    The responses list is shared by reference across every AsyncClient() instantiation
    in a single test, so successive poll iterations consume from the same queue.
    """

    def __init__(self, responses):
        # Hold the list by reference — do NOT copy. Each .post() pops from the shared queue.
        self._responses = responses

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, *_args, **_kwargs):
        return self._responses.pop(0)


def _patch_httpx(*responses):
    """Patch httpx.AsyncClient so .post() pops from the given response queue across all calls."""
    shared_queue = list(responses)
    return patch.object(do.httpx, "AsyncClient", lambda: _FakeAsyncClient(shared_queue))


# Helper: ensure the action's client_id check doesn't bail before the mock fires.
@pytest.fixture(autouse=True)
def _set_github_client_id(monkeypatch):
    monkeypatch.setenv("GITHUB_CLIENT_ID", "Iv1.testclient")


# Test SOD driver — wired via the `test_sod_override` fallback in
# `get_current_sod_store`. Required because the test TestClient bootstrap
# doesn't always preserve `app.state.service.sod_driver` across requests.
@pytest.fixture(autouse=True)
def _test_sod_driver(tmp_path):
    key = Fernet.generate_key().decode()
    cfg = ServiceConfig(
        development=True,
        sod_provider=SodProvider.DEV_FILE.value,
        sod_file_name=str(tmp_path / "test_sod.local"),
        sod_enc_key=key,
    )
    driver = FileSodStorage(cfg)
    set_default_test_sod_driver(driver)
    yield driver
    set_default_test_sod_driver(None)


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_device_start_returns_user_code(bootstrapped_client, user):
    with _patch_httpx(_device_code_response()):
        r = await bootstrapped_client.get(f"/api/v1/graph/user/{user.id}/oauth/github/auth")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "SUCCESS"
    data = body["data"]
    assert data["kind"] == "device"
    assert data["user_code"] == "ABCD-EFGH"
    assert data["verification_uri"] == "https://github.com/login/device"
    assert isinstance(data["state"], str) and data["state"]
    # Session registered for subsequent polling.
    assert data["state"] in do._desktop_oauth_sessions


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_poll_pending_then_success_writes_sod(bootstrapped_client, user):
    # Step 1: start device flow.
    with _patch_httpx(_device_code_response(interval=0)):
        start = await bootstrapped_client.get(f"/api/v1/graph/user/{user.id}/oauth/github/auth")
    state = start.json()["data"]["state"]

    # Step 2: poll. First poll returns authorization_pending, second returns the token.
    token_body = {"access_token": "gho_DEADBEEF", "token_type": "bearer", "scope": "repo,read:org"}
    with _patch_httpx(
        _token_response({"error": "authorization_pending"}),
        _token_response(token_body),
    ):
        poll = await bootstrapped_client.post(
            f"/api/v1/graph/user/{user.id}/oauth/github/wait-callback?state={state}",
        )
    assert poll.status_code == 200, poll.text
    assert poll.json()["status"] == "SUCCESS"

    # SOD now holds the access_token under github_credentials for this user.
    fetched = await get_user_credentials(user, "github_credentials", user.id)
    assert fetched == "gho_DEADBEEF"

    # Session was cleaned up.
    assert state not in do._desktop_oauth_sessions


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_poll_slow_down_bumps_interval(bootstrapped_client, user):
    with _patch_httpx(_device_code_response(interval=0)):
        start = await bootstrapped_client.get(f"/api/v1/graph/user/{user.id}/oauth/github/auth")
    state = start.json()["data"]["state"]
    initial_interval = do._desktop_oauth_sessions[state].poll_interval

    # slow_down → then immediate success (so the test exits the loop).
    with _patch_httpx(
        _token_response({"error": "slow_down"}),
        _token_response({"access_token": "gho_X", "token_type": "bearer", "scope": "repo"}),
    ):
        # Capture the session before it's popped on success to read poll_interval after the bump.
        session = do._desktop_oauth_sessions[state]
        poll = await bootstrapped_client.post(
            f"/api/v1/graph/user/{user.id}/oauth/github/wait-callback?state={state}",
        )
    assert poll.status_code == 200, poll.text
    # We can't read session.poll_interval after the fact (session is popped). Instead,
    # assert the bump happened by intercepting the asyncio.sleep call sequence: the
    # cleanest signal is that the test ran at all — slow_down went through the bump
    # branch without erroring. To be more precise, re-run with sleep mocked:
    assert session.poll_interval >= initial_interval + 5


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_poll_access_denied(bootstrapped_client, user):
    with _patch_httpx(_device_code_response(interval=0)):
        start = await bootstrapped_client.get(f"/api/v1/graph/user/{user.id}/oauth/github/auth")
    state = start.json()["data"]["state"]

    with _patch_httpx(_token_response({"error": "access_denied"})):
        poll = await bootstrapped_client.post(
            f"/api/v1/graph/user/{user.id}/oauth/github/wait-callback?state={state}",
        )
    assert poll.json()["status"] == "FAIL"
    # No SOD entry was written.
    with pytest.raises(KeyError):
        await get_user_credentials(user, "github_credentials", user.id)
    # Session cleaned up.
    assert state not in do._desktop_oauth_sessions


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_status_reflects_sod(bootstrapped_client, user, _test_sod_driver):
    # Write directly through the driver to match how `_get_github_token_for_current_user`
    # reads (composed key = `<_sod_key>_<foreign_key>` with FK=user.id).
    await _test_sod_driver.write_user_sod(
        f"user_github_credentials_{user.id}",
        "gho_FROM_SOD",
        user.id,
    )
    r = await bootstrapped_client.get(f"/api/v1/graph/user/{user.id}/oauth/github/status")
    body = r.json()
    assert r.status_code == 200, r.text
    assert body["status"] == "SUCCESS"
    assert body["data"]["has_token"] is True
    assert body["data"]["status"] == "available"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_disconnect_clears_sod(bootstrapped_client, user, _test_sod_driver):
    # Write directly through the driver (same composed-key shape as production writes).
    await _test_sod_driver.write_user_sod(
        f"user_github_credentials_{user.id}",
        "gho_TO_BE_DELETED",
        user.id,
    )
    r = await bootstrapped_client.post(
        f"/api/v1/graph/user/{user.id}/oauth/github/disconnect",
        json={},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "SUCCESS"
    # SOD entry is gone (read returns KeyError when absent).
    with pytest.raises(KeyError):
        await _test_sod_driver.read_user_sod(f"user_github_credentials_{user.id}", user.id)
