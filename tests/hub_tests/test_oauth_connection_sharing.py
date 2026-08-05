"""The three modes against the REAL hub, with a real provider round trip.

The api-tier twin of this file (`tests/api/test_oauth_dummy_provider_sync.py`)
proves the desktop's routing, adoption and value identity against a hub double.
This one proves the contract the double stands in for: that the hub actually
stores what the provider issued, and actually releases it.

It needs two things the api tier does not, and skips with an actionable reason
when either is missing — never silently:

1. a running hub (the tier's existing reachability check), and
2. the `dummyauth` test provider installed on it.

`tests/hub_tests` skips its whole tier when the hub is down, which is a silent
green — the suite reports success having asserted nothing. Set
``FLOWPAD_REQUIRE_HUB=1`` to turn that skip into a failure, which is what CI for
this work should do.

**The adjudicator earned its keep.** `test_the_hub_value_route_releases_a_token_rows_value`
was written as a first-class expectation (never xfail) because if the hub will
not release a token row's value, modes 2 and 3 cannot work by any mechanism. On
its first real run it failed, and it took THREE hub defects with it — each of
which only became visible once the one in front of it was fixed:

1. `is_key`/`is_plain` were plain methods while their siblings were properties,
   so `env_table.resolve_var_status` tested bound method objects and judged an
   OAUTH_TOKEN row by a `visible_value` it does not have → MISSING.
2. With that fixed the row resolved NA, because there was no branch at all for a
   token the owner holds directly — so the value route's `ref_type is None`
   dispatch, written to serve exactly those rows, was unreachable.
3. With that fixed the read raised KeyError: the dispatch composed the
   ENTITY-scoped SOD key while `save_oauth_credentials` had written the
   USER-scoped one.

Net effect before the fixes: the hub could store an OAuth token and never hand
it back — to anyone, for any provider. That is almost certainly why
`hub_oauth.py` says providers with no local consumer "keep their token on the
hub and are resolved at launch time": releasing it had never worked.
"""

from __future__ import annotations

import os

import httpx
import pytest

from flow_sdk.core.oauth.hub_oauth import hub_credential_value, hub_holds_credential
from tests.hub_tests._local_login import login_as
from tests.utils.dummy_oauth_server import DEFAULT_PORT, dummy_oauth_server

PROVIDER = "dummyauth"
HUB_CREDENTIALS_NAME = "DUMMYAUTH_OAUTH_USER_TOKEN"

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.hub,
    pytest.mark.dummy_oauth,
    pytest.mark.timeout(30),  # do not increase timeout without approval
]

INSTALL_HINT = (
    "the hub has no 'dummyauth' provider. Install it with:\n"
    "  cp -r tests/fixtures/hub_plugins/dummyauth "
    "../test_flowpad/FlowPad/flowpad/plugins/\n"
    "then restart the hub with FLOWPAD_ENABLE_TEST_OAUTH=1. "
    "It is absent by default on purpose — a fake provider must never appear in a "
    "real Connections list."
)


@pytest.fixture(scope="session")
def dummy_server():
    """Fixed port: the hub is a separate process whose plugin config froze these
    URLs at import, so a port chosen here could never be reached."""
    with dummy_oauth_server(port=DEFAULT_PORT) as server:
        yield server


@pytest.fixture(autouse=True)
def _clean_provider_log(dummy_server):
    """The server outlives a test; without this one test's issuances would
    satisfy the next test's assertions."""
    dummy_server.reset()
    yield


@pytest.fixture
def hub_session(hub_base_url, hub_login_payload):
    """A logged-in identity, and the bearer token for direct hub calls.

    `login_as` writes BOTH halves — the sodot token and the config.json user
    record — because `is_logged_in()` reads the user record; writing only the
    token yields a state that behaves as logged out.
    """
    api_key = login_as(hub_login_payload)
    user_id = (hub_login_payload.get("user") or {}).get("id")
    assert user_id, "hub /login returned no user record"
    return {"api_key": api_key, "user_id": user_id, "base_url": hub_base_url}


@pytest.fixture
def dummy_provider_installed(hub_session):
    """Skip — actionably — when the hub is up but lacks the test provider.

    Deliberately a SEPARATE skip from the tier's reachability check: "the hub is
    down" and "the hub is fine but this provider was never installed" need
    different fixes, and one message for both sends people to the wrong one.

    The provider list is the user's env-var TABLE, not an `/oauth/providers`
    route: `oauth` sub-paths parse as `<provider>/<action>`, so a one-segment
    path 404s as "missing params" — which would have made this fixture skip
    forever, including when the provider was correctly installed.
    """
    rows = _provider_rows(hub_session)
    if not any(row.get("name") == PROVIDER for row in rows):
        if os.getenv("FLOWPAD_REQUIRE_HUB") == "1":
            pytest.fail(INSTALL_HINT)
        pytest.skip(INSTALL_HINT)


def _provider_rows(session) -> list[dict]:
    """The OAUTH_PROVIDER_ID rows the hub publishes for this user."""
    response = httpx.get(
        f"{session['base_url']}/api/v1/graph/user/{session['user_id']}/env-var/table",
        headers={"Authorization": f"Bearer {session['api_key']}"},
        timeout=10.0,
    )
    if response.status_code != 200:
        return []
    values = (response.json().get("data") or {}).get("values") or []
    return [v for v in values if v.get("var_type") == "oauth_provider"]


async def test_the_hub_publishes_the_test_provider(dummy_provider_installed, hub_session):
    """The install landed and the hub advertises it — the precondition every
    other test here rests on."""
    row = next(r for r in _provider_rows(hub_session) if r["name"] == PROVIDER)
    assert row["ref_name"] == HUB_CREDENTIALS_NAME


async def test_the_hub_value_route_releases_a_token_rows_value(
    dummy_server, dummy_provider_installed, hub_session
):
    """THE adjudicator — run this first.

    `_adopt_hub_credential` copies a hub-held token into local SOD by reading
    `env-var/{name}/value`. That route gates on the row resolving AVAILABLE, and
    an OAUTH_TOKEN row carries no `visible_value`. If the hub's status predicates
    have the same missing-@property bug this repo just fixed in
    `env_table.py`, the route returns 404, `hub_credential_value` returns None,
    and modes 2 and 3 are impossible by any mechanism.
    """
    assert await hub_holds_credential(HUB_CREDENTIALS_NAME) is not None, (
        "the hub did not answer its env-var table at all"
    )
    if not await hub_holds_credential(HUB_CREDENTIALS_NAME):
        pytest.skip("no dummyauth token on the hub yet — run a connect flow first")

    value = await hub_credential_value(HUB_CREDENTIALS_NAME)
    assert value, (
        "the hub reports holding the credential but will not release its value. "
        "Modes 2 and 3 cannot work until that route returns it — check the hub's "
        "`get_env_var_value` status gate against a token row (the OSS twin of "
        "this bug was `is_plain`/`is_key` being methods rather than properties)."
    )


def disconnect_on_hub(session) -> None:
    """Drop any token the hub holds for the test provider.

    Hub state outlives a test — it is a separate process with its own database —
    so any test whose premise is "the hub holds nothing" has to establish that
    itself rather than assume a fresh tier.
    """
    httpx.get(
        f"{session['base_url']}/api/v1/graph/user/{session['user_id']}/oauth/{PROVIDER}/disconnect",
        headers={"Authorization": f"Bearer {session['api_key']}"},
        timeout=10.0,
    )


def connect_on_hub(session, dummy) -> str:
    """Drive a complete authorization on the hub, as a browser would.

    The hub opens the session and hands back the provider's `auth_url`; the
    provider auto-approves and redirects to the hub's OWN callback (a fixed URI
    it registered), where the hub exchanges the code and stores the token. The
    test only plays the browser — every other hop is the real thing.

    Returns the token the provider issued, so callers can compare against what
    the hub and the desktop end up holding.
    """
    headers = {"Authorization": f"Bearer {session['api_key']}"}
    started = httpx.get(
        f"{session['base_url']}/api/v1/graph/user/{session['user_id']}/oauth/{PROVIDER}/auth",
        headers=headers,
        timeout=10.0,
    )
    assert started.status_code == 200, started.text
    auth_url = (started.json().get("data") or {}).get("auth_url")
    assert auth_url and auth_url.startswith(dummy.base_url), (
        f"the hub did not point at the dummy provider: {auth_url!r}"
    )

    # follow_redirects: provider → hub callback, both hops for real.
    landed = httpx.get(auth_url, follow_redirects=True, timeout=10.0)
    assert landed.status_code == 200, landed.text

    issued = dummy.latest_token
    assert issued, "the provider issued no token — the hub never exchanged the code"
    return issued


# ── mode 1: hub only ─────────────────────────────────────────────────────────


async def test_hub_only_stores_the_token_the_provider_issued(
    dummy_server, dummy_provider_installed, hub_session
):
    issued = connect_on_hub(hub_session, dummy_server)

    assert await hub_holds_credential(HUB_CREDENTIALS_NAME) is True
    assert dummy_server.counts["token"] == 1, "the hub exchanged the code more than once"
    assert await hub_credential_value(HUB_CREDENTIALS_NAME) == issued


# ── mode 2: desktop login, hub holds nothing yet ─────────────────────────────


async def test_desktop_adopts_the_hub_token_and_both_sides_match(
    dummy_server, dummy_provider_installed, hub_session, monkeypatch
):
    """The full chain: provider → hub → desktop SOD, compared by value."""
    from flow_sdk.app.actions.oauth_action import _adopt_hub_credential
    from flow_sdk.builtin.user import User
    from flow_sdk.core.oauth import provider_registry as registry
    from flow_sdk.core.oauth.provider_registry import LocalOAuthProvider, OAuthFlowKind
    from flow_sdk.request_context.methods import get_user_credentials

    disconnect_on_hub(hub_session)
    issued = connect_on_hub(hub_session, dummy_server)

    # A local registry entry is the ONLY condition under which the value is
    # copied into local SOD — without it the desktop gets a row and nothing else.
    monkeypatch.setitem(
        registry._PROVIDERS,
        PROVIDER,
        LocalOAuthProvider(
            name=PROVIDER,
            display_name="Dummy Auth",
            user_credentials_name="dummyauth_credentials",
            kind=OAuthFlowKind.DEVICE,
        ),
    )
    user = User(name="hub-sync-user")
    await user.save()
    monkeypatch.setattr(
        "flow_sdk.request_context.methods.get_current_request_user_fresh",
        _returning(user),
    )

    await _adopt_hub_credential(PROVIDER, "dummyauth_credentials", HUB_CREDENTIALS_NAME)

    local = await get_user_credentials(user, "dummyauth_credentials", user.id)
    hub_value = await hub_credential_value(HUB_CREDENTIALS_NAME)
    assert issued == hub_value == local, (
        f"out of sync — provider issued {issued!r}, hub holds {hub_value!r}, "
        f"desktop holds {local!r}"
    )


# ── mode 3: hub already holds it ─────────────────────────────────────────────


async def test_a_second_connect_leaves_the_hub_on_the_newest_token(
    dummy_server, dummy_provider_installed, hub_session
):
    """Latest login wins, on the hub side — provable only because every
    issuance is a distinct value."""
    first = connect_on_hub(hub_session, dummy_server)
    second = connect_on_hub(hub_session, dummy_server)

    assert first != second
    assert await hub_credential_value(HUB_CREDENTIALS_NAME) == second


def _returning(value):
    async def _fn(*_a, **_kw):
        return value

    return _fn
