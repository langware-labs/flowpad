"""The same connection, exercised through each topology, verified by VALUE.

Three modes:

1. hub only — the token lives on the hub and the desktop holds nothing.
2. desktop login while the hub holds nothing — a full provider round trip, and
   the token ends up on both sides.
3. desktop login while the hub already holds it — no provider round trip at all;
   the desktop adopts what is already there.

Because the provider is fake it can report what it issued, so every assertion is
`provider issued X` ∧ `hub holds X` ∧ `desktop holds X` — never `status ==
AVAILABLE`, which is reached purely from the presence of a name-matching row and
proves nothing about the value (see `test_env_var_table.py:46-64`).

The negatives at the bottom are the ones that would catch this file passing for
the wrong reason.
"""

from __future__ import annotations

import pytest

from flow_sdk.app.actions.oauth_action import _adopt_hub_credential, _handle_wait_callback
from flow_sdk.builtin.user import User
from flow_sdk.core.oauth.hub_oauth import hub_credential_value, hub_holds_credential
from tests.api._oauth_sync_helpers import (  # noqa: F401 — fixtures used by name
    HUB_CREDENTIALS_NAME,
    LOCAL_CREDENTIALS_NAME,
    PROVIDER,
    _isolate_oauth_module_state,
    assert_in_sync,
    dummy_provider,
    hub,
    local_dummy_provider,
    local_value,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def _user(name: str) -> User:
    user = User(name=name)
    await user.save()
    return user


async def _adopt(user, monkeypatch) -> None:
    """Run the adoption the way `wait-callback` does, as this request's user."""
    monkeypatch.setattr(
        "flow_sdk.request_context.methods.get_current_request_user_fresh",
        _returning(user),
    )
    await _adopt_hub_credential(PROVIDER, LOCAL_CREDENTIALS_NAME, HUB_CREDENTIALS_NAME)


def _returning(value):
    async def _fn(*_a, **_kw):
        return value

    return _fn


# ── mode 1: hub only ─────────────────────────────────────────────────────────


async def test_hub_only_leaves_the_token_on_the_hub(hub, dummy_provider):
    """A provider with no local entry keeps its token on the hub. That is the
    Slack shape and it is deliberate — pinned here so the sync tests below are
    not read as a universal claim."""
    issued = hub.complete_flow()

    assert issued == dummy_provider.latest_token
    assert await hub_holds_credential(HUB_CREDENTIALS_NAME) is True
    assert await hub_credential_value(HUB_CREDENTIALS_NAME) == issued


async def test_hub_only_never_writes_a_local_value(hub, dummy_provider, monkeypatch):
    """No local registry entry ⇒ `_adopt_hub_credential` mints the visibility row
    but copies no value. The desktop must not claim to hold what it does not."""
    hub.complete_flow()
    user = await _user("hub-only-user")

    await _adopt(user, monkeypatch)

    assert await local_value(user) is None
    # …and the row still exists, or the provider would read as MISSING.
    assert user.get_env_var(LOCAL_CREDENTIALS_NAME) is not None


# ── mode 2: desktop login, hub holds nothing yet ─────────────────────────────


async def test_desktop_login_with_an_empty_hub_syncs_both_sides(
    hub, dummy_provider, local_dummy_provider, monkeypatch
):
    assert hub.held is None, "precondition: the hub holds nothing"
    user = await _user("mode2-user")

    hub.complete_flow()          # the browser + provider round trip
    await _adopt(user, monkeypatch)  # what wait-callback does once the hub has it

    assert_in_sync(dummy_provider, hub, await local_value(user))


async def test_the_stored_value_is_the_exact_string_the_provider_issued(
    hub, dummy_provider, local_dummy_provider, monkeypatch
):
    """Not 'a token' — THAT token. The dummy server's values appear nowhere else
    in the fixtures, so finding this one in SOD proves it travelled the chain."""
    user = await _user("mode2-exact-user")
    issued = hub.complete_flow()
    await _adopt(user, monkeypatch)

    assert await local_value(user) == issued
    assert issued.startswith("dmy_tok_1_")


# ── mode 3: desktop login, hub already holds it ──────────────────────────────


async def test_desktop_login_when_the_hub_already_holds_it_skips_the_provider(
    hub, dummy_provider, local_dummy_provider, monkeypatch
):
    """The proof is a COUNTER, not a clock: the provider is never called again."""
    hub.complete_flow()
    before = dummy_provider.counts
    user = await _user("mode3-user")

    await _adopt(user, monkeypatch)

    assert dummy_provider.counts == before, (
        "adopting a token the hub already held made a fresh provider request"
    )
    assert_in_sync(dummy_provider, hub, await local_value(user))


async def test_wait_callback_adopts_without_polling_when_the_hub_already_has_it(
    hub, dummy_provider, local_dummy_provider, monkeypatch
):
    """Through the real entry point. The round trip completes BEFORE the call, so
    the first poll succeeds and the 3s interval never elapses — a 'never lands'
    case here would burn the 120s callback budget against a 30s cap."""
    hub.complete_flow()
    user = await _user("mode3-waitcb-user")
    monkeypatch.setattr(
        "flow_sdk.request_context.methods.get_current_request_user_fresh", _returning(user)
    )

    result = await _handle_wait_callback(PROVIDER, state="not-a-desktop-session")

    assert result.data["status"] == "success"
    assert_in_sync(dummy_provider, hub, await local_value(user))


# ── negatives: each catches this file passing for the wrong reason ───────────


async def test_a_row_that_reads_available_does_not_prove_the_value_is_held(
    hub, dummy_provider, local_dummy_provider, monkeypatch
):
    """The trap this whole suite is shaped around. The hub reports the provider
    connected but refuses to release the value; the desktop must end up with a
    row and NO token — and a status-only assertion would have called that a pass."""
    hub.complete_flow()
    hub.release_value = False
    user = await _user("no-release-user")

    await _adopt(user, monkeypatch)

    assert await hub_holds_credential(HUB_CREDENTIALS_NAME) is True
    assert user.get_env_var(LOCAL_CREDENTIALS_NAME) is not None
    assert await local_value(user) is None


async def test_a_stale_local_value_is_replaced_not_kept(
    hub, dummy_provider, local_dummy_provider, monkeypatch
):
    """Seed a sentinel first: if adoption silently no-ops, the sentinel survives
    and the equality assertion is what catches it."""
    from flow_sdk.request_context.methods import set_user_credentials

    user = await _user("stale-user")
    await set_user_credentials(user, LOCAL_CREDENTIALS_NAME, "dmy_tok_STALE", user.id)

    issued = hub.complete_flow()
    await _adopt(user, monkeypatch)

    held = await local_value(user)
    assert held == issued
    assert held != "dmy_tok_STALE"


async def test_latest_login_wins_on_both_sides(
    hub, dummy_provider, local_dummy_provider, monkeypatch
):
    """Two complete grants. Both sides must end on the SECOND token — and the
    first must be gone, which only distinct issuances can prove."""
    user = await _user("latest-wins-user")

    first = hub.complete_flow()
    await _adopt(user, monkeypatch)
    assert await local_value(user) == first

    second = hub.complete_flow()
    await _adopt(user, monkeypatch)

    assert second != first
    assert_in_sync(dummy_provider, hub, await local_value(user))
    assert await local_value(user) != first


async def test_a_refused_authorization_stores_nothing_anywhere(dummy_provider, monkeypatch):
    """The provider says no: no token is issued, so there is nothing to sync."""
    from tests.api._oauth_sync_helpers import HubDouble

    with __import__("tests.utils.dummy_oauth_server", fromlist=["x"]).dummy_oauth_server(
        auto_approve=False
    ) as refusing:
        double = HubDouble(dummy=refusing)
        payload = double.start_auth()
        import httpx

        location = httpx.URL(
            httpx.get(payload["auth_url"], follow_redirects=False).headers["Location"]
        )

        assert location.params.get("error") == "access_denied"
        assert location.params.get("code") is None
        assert refusing.latest_token is None
        assert refusing.counts["token"] == 0
        assert double.held is None
