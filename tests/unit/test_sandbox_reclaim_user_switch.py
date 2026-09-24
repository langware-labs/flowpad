"""The reclaim path a person uses to take a shared sandbox BACK — the "Log in"
button on `SessionTakenOverOverlay` / the avatar dropdown, which resolves to
`start_sandbox_login` -> `/auth/oauth_callback` -> `complete_sandbox_login` ->
`_finalize_login` (‌`flow_sdk/cli/auth/sandbox_login.py`) — is a SEPARATE code
path from `/auth/login_callback`. The switch-detection this repo already has
(`test_login_callback_user_switch.py`: a different incoming user purges
whoever is currently signed in, via `clear_user_data(reason=SWITCHED_OUT)`)
lives ONLY in `login_callback`. `complete_sandbox_login` never runs it.

Proven live on prod compute_node f41f5c42-a8fa-4934-8cda-9080f09d24bd
(2026-09-24): gadi+20 had the machine open; gadi@ reclaimed it via this exact
path; gadi+20's tab silently became gadi@'s session — no purge, no
`SessionTakenOverOverlay` warning — the original FLOWPAD-2151 vulnerability,
reproduced in the reclaim direction. This file pins the gap so a fix has
something to turn green, and a regression here is caught before it reaches
prod again.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.cli.auth.sandbox_login import complete_sandbox_login, start_sandbox_login
from flow_sdk.server import state as server_state

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _clear_session_state():
    """`state.cloud_login_sessions` / `active_cloud_login_id` are module
    globals — start each test from a clean slate and leave none behind."""
    server_state.cloud_login_sessions.clear()
    server_state.active_cloud_login_id = None
    yield
    server_state.cloud_login_sessions.clear()
    server_state.active_cloud_login_id = None


@pytest.fixture
def finalize_login():
    with patch("flow_sdk.cli.auth.sandbox_login._finalize_login", new=AsyncMock()) as spy:
        yield spy


@pytest.fixture
def clear_user_data():
    with patch("flow_sdk.cli.auth.cloud_login.clear_user_data", new=AsyncMock()) as spy:
        yield spy


def _validate_returns(user_id: str):
    return patch(
        "flow_sdk.cli.auth.sandbox_login.validate_api_key_async",
        new=AsyncMock(return_value={"id": user_id}),
    )


def _current_user(user_id: str | None):
    value = {"id": user_id} if user_id else None
    return patch("flow_sdk.cli.app_config.get_user", return_value=value)


class _FakeTokenResponse:
    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return {"access_token": "hub-issued-token", "refresh_token": None, "expires_in": 3600}


class _FakeAsyncClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc_info):
        return False

    async def post(self, _url, data=None):  # noqa: ARG002
        return _FakeTokenResponse()


def _start_and_get_request_id() -> str:
    """Mint a real pending session + PKCE verifier the way the "Log in" click
    does, and hand back its request id — `start_sandbox_login`'s own return
    value drops it (`oauth_request_id` never leaves the process), so tests
    read it the only other way anything does: the one active session."""
    with patch("flow_sdk.cli.auth.sandbox_login.httpx.AsyncClient"):
        start_sandbox_login("sandbox-abc123")
    request_id = server_state.active_cloud_login_id
    assert request_id, "start_sandbox_login did not open a pending session"
    return request_id


async def _complete(request_id: str) -> None:
    with patch("flow_sdk.cli.auth.sandbox_login.httpx.AsyncClient", return_value=_FakeAsyncClient()):
        await complete_sandbox_login(request_id, "auth-code-from-hub")


@pytest.mark.asyncio
async def test_different_user_triggers_purge_before_finalize(finalize_login, clear_user_data):
    """user-1 has the sandbox open; user-2 reclaims it via "Log in" — user-1
    must be purged BEFORE user-2's login finalizes. This is the one that is
    currently red: nothing in `complete_sandbox_login` calls `clear_user_data`
    at all, so user-1's tab is silently repainted as user-2 with no warning.
    """
    calls: list[str] = []
    clear_user_data.side_effect = lambda *_a, **_k: calls.append("purge")
    finalize_login.side_effect = lambda *_a, **_k: calls.append("finalize")
    request_id = _start_and_get_request_id()

    with _validate_returns("user-2"), _current_user("user-1"):
        await _complete(request_id)

    clear_user_data.assert_awaited_once()
    finalize_login.assert_awaited_once()
    assert calls == ["purge", "finalize"], "the outgoing user must be cleared before the new login finalizes"


@pytest.mark.asyncio
async def test_same_user_reclaiming_does_not_purge(finalize_login, clear_user_data):
    """user-1 reclaiming their OWN machine is not a switch."""
    request_id = _start_and_get_request_id()

    with _validate_returns("user-1"), _current_user("user-1"):
        await _complete(request_id)

    clear_user_data.assert_not_awaited()
    finalize_login.assert_awaited_once()


@pytest.mark.asyncio
async def test_no_prior_user_does_not_purge(finalize_login, clear_user_data):
    """First-ever login on a fresh sandbox — nobody to switch out."""
    request_id = _start_and_get_request_id()

    with _validate_returns("user-1"), _current_user(None):
        await _complete(request_id)

    clear_user_data.assert_not_awaited()
    finalize_login.assert_awaited_once()


@pytest.mark.asyncio
async def test_a_failed_token_exchange_never_reaches_the_switch_check(finalize_login, clear_user_data):
    """A code that fails to redeem must not be able to trigger a logout of
    whoever is currently signed in."""
    request_id = _start_and_get_request_id()

    with (
        patch(
            "flow_sdk.cli.auth.sandbox_login.validate_api_key_async",
            new=AsyncMock(side_effect=ValueError("bad token")),
        ),
        _current_user("user-1"),
        pytest.raises(ValueError),
    ):
        await _complete(request_id)

    clear_user_data.assert_not_awaited()
    finalize_login.assert_not_awaited()
