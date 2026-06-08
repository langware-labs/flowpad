"""
OAuth action stub tests for desktop mode.

Migrated from FlowPad: flowpad/hub/tests/api/test_oauth.py
Adapted for flow-cli:
- Uses flow-cli import paths (no flowpad.hub.*)
- SOD-backed desktop credential status for local providers
- No multi-user (single @local user)
- No grant_role, grant_access_to_public_data, or Project creation
- Tests the desktop OAuth stub responses for API wire compatibility
- Verifies the OAuthAction enum values match production
"""

import pytest
from cryptography.fernet import Fernet

from flow_sdk.api.oauth_api import OAuthAction, OAuthErrorCode, OauthClientRequestInfo
from flow_sdk.config import ServiceConfig, SodProvider
from flow_sdk.request_context.methods import set_default_test_sod_driver, set_user_credentials
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus
from flow_sdk.sod.file_sod import FileSodStorage


# -- Unit tests for OAuth types (no server needed) --


def test_oauth_action_enum_values():
    """Test OAuthAction enum contains all production values."""
    assert OAuthAction.Auth == "auth"
    assert OAuthAction.Callback == "callback"
    assert OAuthAction.WaitCallback == "wait-callback"
    assert OAuthAction.Attach == "attach"
    assert OAuthAction.Detach == "detach"
    assert OAuthAction.Status == "status"
    assert OAuthAction.Disconnect == "disconnect"


def test_oauth_error_code_enum_values():
    """Test OAuthErrorCode enum contains all production values."""
    assert OAuthErrorCode.NO_REQUEST_CONTEXT == "no_request_context"
    assert OAuthErrorCode.USER_NOT_FOUND == "user_not_found"
    assert OAuthErrorCode.NO_TARGET_ENTITY == "no_target_entity"
    assert OAuthErrorCode.TARGET_ENTITY_NOT_FOUND == "target_entity_not_found"
    assert OAuthErrorCode.SOD_NOT_FOUND_IN_ENV_VARS == "sod_not_found_in_env_vars"
    assert OAuthErrorCode.NO_SOD_FOUND == "no_sod_found"
    assert OAuthErrorCode.SOD_NOT_FOUND == "sod_not_found"


def test_oauth_client_request_info_model():
    """Test OauthClientRequestInfo model creation."""
    info = OauthClientRequestInfo(
        oauth_request_id="req-123",
        provider="anthropic",
        auth_url="https://auth.example.com/authorize",
    )
    assert info.oauth_request_id == "req-123"
    assert info.provider == "anthropic"
    assert info.auth_url == "https://auth.example.com/authorize"

    # Test model_dump
    dumped = info.model_dump()
    assert dumped["oauth_request_id"] == "req-123"
    assert dumped["provider"] == "anthropic"


# -- API tests for desktop OAuth stub endpoints --


@pytest.fixture
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


@pytest.mark.asyncio
async def test_oauth_status_check(bootstrapped_client, user):
    """
    Test: OAuth status check returns desktop status.

    In desktop mode, status always returns a valid response indicating
    whether credentials are available locally.
    """
    client = bootstrapped_client

    # Check status for a generic provider
    response = await client.get(
        f"/api/v1/graph/user/{user.id}/oauth/test_provider/status"
    )

    assert response.status_code == 200, f"OAuth status check failed: {response.text}"
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value

    data = res["data"]
    assert "status" in data, "Response should contain status field"
    assert "has_token" in data, "Response should contain has_token field"
    assert "is_attached" in data, "Response should contain is_attached field"
    # For a non-anthropic provider in desktop mode, status should be missing
    assert data["status"] == "missing"
    assert data["has_token"] is False


@pytest.mark.asyncio
async def test_oauth_attach_stub(bootstrapped_client, user):
    """
    Test: OAuth attach returns success stub response.

    In desktop mode, attach is a no-op stub for API compatibility.
    """
    client = bootstrapped_client

    response = await client.post(
        f"/api/v1/graph/user/{user.id}/oauth/test_provider/attach"
    )

    assert response.status_code == 200, f"OAuth attach failed: {response.text}"
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert "attached" in res["message"].lower() or "stub" in res["message"].lower()


@pytest.mark.asyncio
async def test_oauth_detach_stub(bootstrapped_client, user):
    """
    Test: OAuth detach returns success stub response.

    In desktop mode, detach is a no-op stub for API compatibility.
    """
    client = bootstrapped_client

    response = await client.post(
        f"/api/v1/graph/user/{user.id}/oauth/test_provider/detach"
    )

    assert response.status_code == 200, f"OAuth detach failed: {response.text}"
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert "detach" in res["message"].lower() or "stub" in res["message"].lower()


@pytest.mark.asyncio
async def test_oauth_disconnect_stub(bootstrapped_client, user):
    """
    Test: OAuth disconnect returns success stub response.

    In desktop mode, disconnect is a no-op stub for API compatibility.
    """
    client = bootstrapped_client

    response = await client.post(
        f"/api/v1/graph/user/{user.id}/oauth/test_provider/disconnect"
    )

    assert response.status_code == 200, f"OAuth disconnect failed: {response.text}"
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert "disconnect" in res["message"].lower() or "stub" in res["message"].lower()


@pytest.mark.asyncio
async def test_oauth_missing_provider(bootstrapped_client, user):
    """
    Test: OAuth action without provider returns error.
    """
    client = bootstrapped_client

    # Request with no sub_path at all (just /oauth)
    response = await client.get(
        f"/api/v1/graph/user/{user.id}/oauth"
    )

    # Should fail - no provider specified
    # The graph handler may return 400 or the action may return FAIL status
    if response.status_code == 200:
        res = response.json()
        assert res["status"] == "FAIL"


@pytest.mark.asyncio
async def test_oauth_anthropic_status(bootstrapped_client, user, _test_sod_driver):
    """
    Test: OAuth status for anthropic provider returns status info.

    The anthropic provider checks Flowpad-owned SOD credentials in desktop
    mode. Missing credentials should still return a valid status response.
    """
    client = bootstrapped_client

    response = await client.get(
        f"/api/v1/graph/user/{user.id}/oauth/anthropic/status"
    )

    assert response.status_code == 200, f"Anthropic OAuth status failed: {response.text}"
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value

    data = res["data"]
    assert "status" in data
    assert "has_token" in data
    # Status can be "available" or "missing" depending on Flowpad SOD state.
    assert data["status"] in ("available", "missing")


@pytest.mark.asyncio
async def test_oauth_anthropic_status_reflects_flowpad_sod(bootstrapped_client, user, _test_sod_driver):
    await set_user_credentials(
        user,
        "anthropic_credentials",
        {"provider": "anthropic", "access_token": "test-token"},
        user.id,
    )

    response = await bootstrapped_client.get(
        f"/api/v1/graph/user/{user.id}/oauth/anthropic/status"
    )

    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["status"] == "available"
    assert res["data"]["has_token"] is True
    assert res["data"]["auth_method"] == "anthropic"
