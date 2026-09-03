"""Real Atlassian (Jira + Confluence), through the hub, adopted onto the desktop.

Atlassian is the same shape as Slack: the app's callback URLs are exact-match
and hub-hosted, so the desktop can only delegate. The token also expires
hourly, so the hub is the one that refreshes it and the desktop reads through
the hub rather than copying.

**Split deliberately in two.** Everything short of the consent click is machine
checkable and runs unattended: the desktop routes Atlassian to the hub, the hub
builds a real `auth.atlassian.com` authorize URL carrying the redirect it
registered, the `api.atlassian.com` audience and the refresh-capable scope set.
Only the click itself needs a person — a real Atlassian login means a real
password and a site picker. So the sync assertions SKIP with instructions until
somebody has authorized, and assert for real the moment someone has.

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
    hub_holds_credential,
    hub_start_auth,
)
from flow_sdk.core.oauth.provider_registry import (
    ATLASSIAN,
    get_local_provider,
    prefers_hub_flow,
    user_credentials_name,
)
from tests.hub_tests._local_login import login_as

HUB_NAME = hub_credentials_name_for(ATLASSIAN)  # ATLASSIAN_OAUTH_USER_TOKEN

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.hub,
    pytest.mark.timeout(30),  # do not increase timeout without approval
]

CONNECT_HINT = (
    "no Atlassian token on the hub yet. Connect once, then re-run:\n"
    "  1. GET {hub}/api/v1/graph/user/<your-id>/oauth/atlassian/auth  (Bearer token)\n"
    "  2. open the `auth_url` it returns, pick the site, click Accept\n"
    "  3. re-run this file\n"
    "The click needs a person — a real Atlassian login means a real password, "
    "which is exactly what the dummy provider stands in for in every other test."
)

REQUIRED_SCOPES = {"read:me", "offline_access", "read:jira-work", "read:confluence-content.all"}


@pytest.fixture
def hub_session(hub_base_url, hub_login_payload):
    api_key = login_as(hub_login_payload)
    user_id = (hub_login_payload.get("user") or {}).get("id")
    assert user_id, "hub /login returned no user record"
    return {"api_key": api_key, "user_id": user_id, "base_url": hub_base_url}


# ── unattended: everything short of the consent click ────────────────────────


def test_atlassian_is_registered_locally_so_its_token_can_be_named():
    """The entry is what lets `test`, `attach` and the Connections row resolve
    a credential name for a flow the desktop never ran itself."""
    provider = get_local_provider(ATLASSIAN)
    assert provider is not None, "Atlassian is not in the local registry"
    assert user_credentials_name(ATLASSIAN) == "atlassian_credentials"


def test_atlassian_still_routes_to_the_hub_despite_being_registered():
    """Registering a provider locally normally means "run it here". Atlassian
    has no endpoints, so it must keep routing to the hub — the desktop holds
    neither the secret nor a callback URL the app registered."""
    provider = get_local_provider(ATLASSIAN)
    assert provider.endpoints is None
    assert prefers_hub_flow(ATLASSIAN) is True


async def test_the_hub_builds_a_real_atlassian_authorize_url(hub_session):
    """Proves the hub's Atlassian app is configured for THIS environment and the
    redirect it will send is the one registered on that app."""
    payload = await hub_start_auth(ATLASSIAN)
    assert payload, "the hub would not start an Atlassian flow — check ATLASSIAN_CLIENT_ID/SECRET"

    url = payload.get("auth_url") or ""
    assert url.startswith("https://auth.atlassian.com/authorize"), url
    parsed = httpx.URL(url)
    assert parsed.params.get("client_id"), "no client_id — the hub has no Atlassian app configured"
    assert parsed.params.get("state"), "no state — the callback would be unverifiable"
    assert parsed.params.get("audience") == "api.atlassian.com", "no audience — every API call would 401"
    assert parsed.params.get("prompt") == "consent", "without prompt=consent no refresh token is issued"
    assert parsed.params.get("redirect_uri") == (
        f"{hub_session['base_url']}/api/v1/graph/oauth/atlassian/callback"
    ), "the hub would send Atlassian a redirect its app has not registered"
    scopes = set((parsed.params.get("scope") or "").split())
    missing = REQUIRED_SCOPES - scopes
    assert not missing, f"scope is missing {sorted(missing)} — the token could not do its job"


# ── needs one human click, then proves the whole chain ───────────────────────


async def test_the_hub_holds_and_releases_the_atlassian_token(hub_session):
    if not await hub_holds_credential(HUB_NAME):
        pytest.skip(CONNECT_HINT)

    value = await hub_credential_value(HUB_NAME)
    assert value, "the hub holds an Atlassian token but will not release its value"


async def test_the_hub_held_atlassian_token_actually_works(hub_session):
    """The strongest claim available: call Atlassian with what the hub holds.
    `/me` is the one endpoint that needs no site, so it is the probe."""
    if not await hub_holds_credential(HUB_NAME):
        pytest.skip(CONNECT_HINT)
    if os.getenv("FLOWPAD_SKIP_LIVE_PROVIDER") == "1":
        pytest.skip("live provider calls disabled")

    from flow_sdk.core.oauth.provider_probe import run_probe

    token = await hub_credential_value(HUB_NAME)
    result = await run_probe(ATLASSIAN, token)
    assert result.ok is True, f"Atlassian refused the token: {result.detail!r}"
    assert result.identity, "/me accepted the token but named no identity"
