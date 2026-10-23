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

from flow_sdk.cloud_client.auth_status import LogoutReason
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


@pytest.fixture(autouse=True)
def _unarmed_box():
    """These cases are an UNARMED box (an armed one refuses a switch without the gate secret).
    Another test may have left this instance's local gate token; set it aside and put it back."""
    from flow_sdk.instance_settings import cookie_gate

    path = cookie_gate._token_path()
    saved = path.read_bytes() if path.exists() else None
    cookie_gate.clear_cookie_gate()
    yield
    if saved is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(saved)


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

    clear_user_data.assert_awaited_once_with(reason=LogoutReason.SWITCHED_OUT)
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


def test_a_refused_next_still_lands_in_the_app(client, finalize_login):
    """A link that asked to land somewhere never ends on the static sign-in page: an unsafe
    path is swapped for the app's root, and a safe one is followed."""
    with _validate_returns("user-1"), _current_user("user-1"):
        refused = _callback(client, next="//evil.com/x")
        followed = _callback(client, next="/dock/home?action=launch&target=p1")

    assert (refused.status_code, refused.headers["location"]) == (302, "/")
    assert (followed.status_code, followed.headers["location"]) == (302, "/dock/home?action=launch&target=p1")


# ── the owner guard: only the gate-secret holder (the hub) may switch/re-arm ──
# A door-passer (ticket/grant) reaches login_callback with a valid key but NOT the
# raw secret. Switching the logged-in identity or re-arming the gate for such a
# caller is a full box takeover, so both are refused unless the box is clean or the
# caller presents the current secret as the machine header.


def _armed(secret: str | None):
    return patch("flow_sdk.instance_settings.cookie_gate.get_cookie_gate", return_value=secret)


@pytest.fixture
def set_cookie_gate():
    with patch("flow_sdk.instance_settings.cookie_gate.set_cookie", new=lambda *_a, **_k: None) as spy:
        yield spy


def test_switch_without_the_gate_secret_is_refused(client, finalize_login, clear_user_data):
    """user-2 reaches an Alice-owned, armed box with a valid key but no secret → 403, nothing mutated."""
    with _validate_returns("user-2"), _current_user("user-1"), _armed("alice-secret"):
        resp = _callback(client)

    assert resp.status_code == 403
    clear_user_data.assert_not_awaited()
    finalize_login.assert_not_awaited()


def test_switch_with_the_gate_secret_is_allowed(client, finalize_login, clear_user_data):
    """The hub drives the same switch carrying the secret header → it proceeds (purge+finalize)."""
    with _validate_returns("user-2"), _current_user("user-1"), _armed("alice-secret"):
        resp = client.get(
            "/auth/login_callback",
            params={"flowpad-api-key": "k"},
            headers={"x-cookie-gate": "alice-secret"},
            follow_redirects=False,
        )

    assert resp.status_code != 403
    clear_user_data.assert_awaited_once()
    finalize_login.assert_awaited_once()


def test_rearm_to_a_different_secret_without_the_current_one_is_refused(
    client, finalize_login, set_cookie_gate
):
    """Same user, but re-pointing the gate to a new secret without proving the current one → 403."""
    with _validate_returns("user-1"), _current_user("user-1"), _armed("alice-secret"):
        resp = _callback(client, **{"cookie-gate": "attacker-secret"})

    assert resp.status_code == 403
    finalize_login.assert_not_awaited()


def test_clean_box_first_login_needs_no_secret(client, finalize_login, set_cookie_gate):
    """A clean box (no user, no gate) takes a first login and arms its gate with no secret — the real open."""
    with _validate_returns("user-1"), _current_user(None), _armed(None):
        resp = _callback(client, **{"cookie-gate": "fresh-secret"})

    assert resp.status_code != 403
    finalize_login.assert_awaited_once()
