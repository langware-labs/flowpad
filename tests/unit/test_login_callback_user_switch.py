"""A shared sandbox has exactly one logged-in identity for the whole instance
(see ``flow_sdk/cli/app_config.py``). If ``/auth/login_callback`` resolves a
DIFFERENT person than whoever is currently signed in, the outgoing person's
session and hub-mirrored data must be cleared BEFORE the new login finalizes —
otherwise the incoming person inherits the previous one's stream inbox
(the FLOWPAD-2151 session-hijack bug: user A shares a sandbox link, user B
logs in on it, user A reopens the link and sees user B's data).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from flow_sdk.server.routes import auth as auth_route

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(auth_route.router)
    return TestClient(app)


@pytest.fixture(autouse=True)
def _secrets_enabled():
    with patch.object(auth_route, "is_secrets_enabled", return_value=True):
        yield


@pytest.fixture
def finalize_login():
    with patch("flow_sdk.cli.auth.cloud_login._finalize_login", new=AsyncMock()) as spy:
        yield spy


@pytest.fixture
def clear_user_data():
    with patch("flow_sdk.cli.auth.cloud_login.clear_user_data", new=AsyncMock()) as spy:
        yield spy


def _validate_returns(user_id: str):
    return patch(
        "flow_sdk.cli.auth.hub_login.validate_api_key_async",
        new=AsyncMock(return_value={"id": user_id}),
    )


def _current_user(user_id: str | None):
    value = {"id": user_id} if user_id else None
    return patch("flow_sdk.cli.app_config.get_user", return_value=value)


def _callback(client, **params):
    return client.get("/auth/login_callback", params={"flowpad-api-key": "k", **params}, follow_redirects=False)


def test_different_user_triggers_purge_before_finalize(client, finalize_login, clear_user_data):
    """user-1 is signed in; user-2's key arrives — purge user-1 first, then finalize as user-2."""
    calls: list[str] = []
    clear_user_data.side_effect = lambda *_a, **_k: calls.append("purge")
    finalize_login.side_effect = lambda *_a, **_k: calls.append("finalize")

    with _validate_returns("user-2"), _current_user("user-1"):
        _callback(client)

    clear_user_data.assert_awaited_once_with(reason="switched_out")
    finalize_login.assert_awaited_once()
    assert calls == ["purge", "finalize"], "the outgoing user must be cleared before the new login finalizes"


def test_same_user_relogging_in_does_not_purge(client, finalize_login, clear_user_data):
    """user-1 re-opening their own hub link (a fresh login_callback for themselves) is not a switch."""
    with _validate_returns("user-1"), _current_user("user-1"):
        _callback(client)

    clear_user_data.assert_not_awaited()
    finalize_login.assert_awaited_once()


def test_no_prior_user_does_not_purge(client, finalize_login, clear_user_data):
    """First login on a fresh instance — nobody to switch out."""
    with _validate_returns("user-1"), _current_user(None):
        _callback(client)

    clear_user_data.assert_not_awaited()
    finalize_login.assert_awaited_once()


def test_rejected_key_never_reaches_the_switch_check(client, clear_user_data):
    """An unvalidated caller must not be able to trigger a logout of whoever is signed in."""
    with (
        patch(
            "flow_sdk.cli.auth.hub_login.validate_api_key_async",
            new=AsyncMock(side_effect=ValueError("bad key")),
        ),
        patch("flow_sdk.cli.auth.cloud_login._broadcast_oauth_error", new=AsyncMock()),
        _current_user("user-1"),
    ):
        _callback(client)

    clear_user_data.assert_not_awaited()
