"""Real Zoom, through the hub, adopted onto the desktop.

Same shape as Atlassian: the app's callbacks are hub-hosted, so the desktop can
only delegate, and the token expires hourly with a rotating refresh token, so the
hub refreshes it and the desktop reads through the hub rather than copying.

**Split deliberately in two.** Everything short of the consent click runs
unattended: the desktop routes Zoom to the hub, and the hub builds a real
`zoom.us` authorize URL carrying the redirect it derives. Zoom differs from the
others in two ways this file pins: the authorize URL carries **no** `scope`
(the grant is the scope list ticked on the app), and Zoom refuses a `localhost`
callback at consent time ("Invalid redirect", 4,700) — so against a local hub the
consent half can never run, and a deployed hub (dev) is where it is proven.

No client id, app name or secret appears here: this repository is public, and
the hub's environment is the only place those live.
"""

from __future__ import annotations

import os

import httpx
import pytest

from flow_sdk.core.oauth.hub_oauth import (
    hub_credential_value,
    hub_credentials_name_for,
    hub_start_auth,
)
from flow_sdk.core.oauth.provider_registry import (
    ZOOM,
    get_local_provider,
    prefers_hub_flow,
    user_credentials_name,
)

HUB_NAME = hub_credentials_name_for(ZOOM)  # ZOOM_OAUTH_USER_TOKEN

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.hub,
    pytest.mark.timeout(30),  # do not increase timeout without approval
]

CONNECT_HINT = (
    "no Zoom token on the hub yet. Zoom refuses a localhost callback, so connect on a\n"
    "deployed hub (dev) and point this run at it:\n"
    "  1. GET {hub}/api/v1/graph/user/<your-id>/oauth/zoom/auth  (Bearer token)\n"
    "  2. open the `auth_url` it returns and click Allow\n"
    "  3. re-run this file against that hub"
)


# ── unattended: everything short of the consent click ────────────────────────


def test_zoom_is_registered_locally_so_its_token_can_be_named():
    """The entry is what lets `test`, `attach` and the Connections row resolve
    a credential name for a flow the desktop never ran itself."""
    provider = get_local_provider(ZOOM)
    assert provider is not None, "Zoom is not in the local registry"
    assert user_credentials_name(ZOOM) == "zoom_credentials"


def test_zoom_routes_to_the_hub():
    """No endpoints: the hub holds the secret (sent as HTTP Basic) and the
    registered callbacks, so the flow must run there."""
    provider = get_local_provider(ZOOM)
    assert provider.endpoints is None
    assert prefers_hub_flow(ZOOM) is True


async def test_the_hub_builds_a_real_zoom_authorize_url(hub_session):
    """Proves the hub's Zoom app is configured for THIS environment and the
    redirect it will send is the one it derives from its own base URL."""
    payload = await hub_start_auth(ZOOM)
    assert payload, "the hub would not start a Zoom flow — check ZOOM_CLIENT_ID/SECRET"

    url = payload.get("auth_url") or ""
    assert url.startswith("https://zoom.us/oauth/authorize"), url
    parsed = httpx.URL(url)
    assert parsed.params.get("client_id"), "no client_id — the hub has no Zoom app configured"
    assert parsed.params.get("state"), "no state — the callback would be unverifiable"
    assert parsed.params.get("response_type") == "code"
    assert "scope" not in parsed.params, "Zoom takes the grant from the app; a scope param is not ours to send"
    assert parsed.params.get("redirect_uri") == (f"{hub_session['base_url']}/api/v1/graph/oauth/zoom/callback"), (
        "the hub would send Zoom a redirect it did not derive from its own base"
    )


# ── needs one human click on a deployed hub, then proves the whole chain ─────


async def test_the_hub_holds_and_releases_the_zoom_token(hub_session):
    value = await hub_credential_value(HUB_NAME)
    if value is None:
        pytest.skip(CONNECT_HINT)
    assert value, "the hub holds a Zoom token but will not release its value"


async def test_the_hub_held_zoom_token_actually_works(hub_session):
    """Call Zoom with what the hub holds: `/v2/users/me` names the person who
    consented, and needs nothing beyond `user:read:user`."""
    if os.getenv("FLOWPAD_SKIP_LIVE_PROVIDER") == "1":
        pytest.skip("live provider calls disabled")

    from flow_sdk.core.oauth.provider_probe import run_probe

    token = await hub_credential_value(HUB_NAME)
    if token is None:
        pytest.skip(CONNECT_HINT)
    result = await run_probe(ZOOM, token)
    assert result.ok is True, f"Zoom refused the token: {result.detail!r}"
    assert result.identity, "/users/me accepted the token but named no identity"
