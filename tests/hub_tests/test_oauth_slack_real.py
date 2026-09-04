"""Real Slack, through the hub, adopted onto the desktop.

Slack is the shape connection sharing exists for: the hub holds the client
secret AND the registered redirect URI (Slack matches
`<hub>/api/v1/graph/oauth/slack/callback` exactly, so a loopback port could never
be registered), while the token has to end up on the desktop for a local
consumer — an ingest driver — to use it.

**Split deliberately in two.** Everything up to the consent screen is machine
checkable and runs unattended: that the desktop routes Slack to the hub, that
the hub builds a real Slack v2 authorize URL with the redirect it registered,
and that the local registry entry which lets the token be adopted actually
exists. Only the click itself needs a person — a real Slack login means a real
password, a real workspace and possibly a passkey, which is exactly what the
dummy provider was built to stand in for everywhere else.

So the sync assertions SKIP with instructions when nobody has authorized yet,
and assert for real the moment someone has. Connect once and this file proves
the whole chain; until then it proves everything that does not need a human.
"""

from __future__ import annotations

import os

import httpx
import pytest

from flow_sdk.core.oauth.hub_oauth import (
    hub_credential_value,
    hub_credentials_name_for,
    hub_holds_credential,
    hub_start_auth,
)
from flow_sdk.core.oauth.provider_registry import (
    SLACK,
    get_local_provider,
    prefers_hub_flow,
    user_credentials_name,
)

HUB_NAME = hub_credentials_name_for(SLACK)  # SLACK_OAUTH_USER_TOKEN

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.hub,
    pytest.mark.timeout(30),  # do not increase timeout without approval
]

CONNECT_HINT = (
    "no Slack token on the hub yet. Connect once, then re-run:\n"
    "  1. GET {hub}/api/v1/graph/user/<your-id>/oauth/slack/auth  (Bearer token)\n"
    "  2. open the `auth_url` it returns, pick the workspace, click Allow\n"
    "  3. re-run this file\n"
    "The click needs a person — a real Slack login means a real password and "
    "possibly a passkey, which is exactly what the dummy provider stands in for "
    "in every other test."
)




# ── unattended: everything short of the consent click ────────────────────────


def test_slack_is_registered_locally_so_its_token_can_be_adopted():
    """The entry is not decoration. `_adopt_hub_credential` copies a hub-held
    token into local SOD only for a provider it can look up — without this the
    desktop finishes a successful Slack flow holding a row and no token."""
    provider = get_local_provider(SLACK)
    assert provider is not None, "Slack is not in the local registry"
    assert user_credentials_name(SLACK) == "slack_credentials"


def test_slack_still_routes_to_the_hub_despite_being_registered():
    """The trap this ordering creates: registering a provider locally normally
    means "run it here". Slack has no endpoints, so it must keep routing to the
    hub — otherwise the desktop would try a flow it cannot run and fail."""
    provider = get_local_provider(SLACK)
    assert provider.endpoints is None
    assert prefers_hub_flow(SLACK) is True


async def test_the_hub_builds_a_real_slack_authorize_url(hub_session):
    """Proves the hub's Slack app is configured and the redirect it will send
    Slack is the one Slack has registered."""
    payload = await hub_start_auth(SLACK)
    assert payload, "the hub would not start a Slack flow — check SLACK_CLIENT_ID/SECRET"

    url = payload.get("auth_url") or ""
    assert url.startswith("https://slack.com/oauth/v2/authorize"), url
    parsed = httpx.URL(url)
    assert parsed.params.get("client_id"), "no client_id — the hub has no Slack app configured"
    assert parsed.params.get("state"), "no state — the callback would be unverifiable"
    assert parsed.params.get("redirect_uri") == (
        f"{hub_session['base_url']}/api/v1/graph/oauth/slack/callback"
    ), "the hub would send Slack a redirect it has not registered"
    # Slack v2 splits bot and user scopes; the user token is the one a desktop
    # consumer acts with, so its absence would be a silent capability gap.
    assert parsed.params.get("user_scope"), "no user_scope — no user token would come back"


# ── needs one human click, then proves the whole chain ───────────────────────


async def test_the_hub_holds_and_releases_the_slack_token(hub_session):
    if not await hub_holds_credential(HUB_NAME):
        pytest.skip(CONNECT_HINT)

    value = await hub_credential_value(HUB_NAME)
    assert value, (
        "the hub holds a Slack token but will not release its value — the "
        "env-var value route regressed (see the three defects fixed in "
        "flowpad 83576b995)"
    )
    assert value.startswith("xox"), f"not a Slack token shape: {value[:6]}…"


async def test_the_desktop_adopts_the_slack_token_verbatim(hub_session, monkeypatch):
    """The whole point of connection sharing: the hub ran the flow, the desktop
    ends up holding the same token, so a local consumer can use it."""
    if not await hub_holds_credential(HUB_NAME):
        pytest.skip(CONNECT_HINT)

    from flow_sdk.app.actions.oauth_action import _adopt_hub_credential
    from flow_sdk.builtin.user import User
    from flow_sdk.request_context.methods import get_user_credentials

    hub_value = await hub_credential_value(HUB_NAME)
    assert hub_value, "precondition: the hub must release the value"

    user = User(name="slack-adopt-user")
    await user.save()

    async def _fresh(*_a, **_kw):
        return user

    monkeypatch.setattr(
        "flow_sdk.request_context.methods.get_current_request_user_fresh", _fresh
    )
    await _adopt_hub_credential(SLACK, user_credentials_name(SLACK), HUB_NAME)

    local = await get_user_credentials(user, user_credentials_name(SLACK), user.id)
    assert local == hub_value, (
        f"out of sync — hub holds {hub_value[:8]}…, desktop holds "
        f"{str(local)[:8]}…"
    )


async def test_the_adopted_slack_token_actually_works(hub_session):
    """The strongest claim available: call Slack with what the desktop holds.

    A stored value that Slack rejects is not a connection, however green the
    Connections tab looks — this is the one check that distinguishes them.
    """
    if not await hub_holds_credential(HUB_NAME):
        pytest.skip(CONNECT_HINT)
    if os.getenv("FLOWPAD_SKIP_LIVE_PROVIDER") == "1":
        pytest.skip("live provider calls disabled")

    from flow_sdk.core.oauth.provider_probe import run_probe

    token = await hub_credential_value(HUB_NAME)
    result = await run_probe(SLACK, token)
    assert result.ok is True, f"Slack refused the token: {result.detail!r}"
    assert result.identity, "auth.test accepted the token but named no identity"
