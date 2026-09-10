"""FlowPad's own account as a registered OAuth provider, beside the api-key login.

The point of these tests is the COEXISTENCE. `flowpad` (a real authorization-code
grant against the hub) and `flowpad_cloud` (the pre-existing api-key sign-in) are
two ways into the same account, and both have to stay available and independently
visible. Almost every regression this file guards is one of them quietly
swallowing the other.

The rest pins what the `{hub}` placeholder means: those URLs are expanded against
the configured hub at lookup time rather than baked in, so pointing an instance at
a different hub points the whole grant at it too.
"""

from urllib.parse import parse_qs, urlparse

import pytest

from flow_sdk.api.oauth_api import OAuthProvider
from flow_sdk.app.actions import desktop_oauth as do
from flow_sdk.core.oauth import provider_registry as registry
from flow_sdk.core.oauth.provider_probe import ProbeResult, run_probe
from flow_sdk.core.oauth.provider_registry import (
    FLOWPAD,
    OAuthFlowKind,
    TokenShape,
    client_id_for,
    get_local_provider,
    publishable_local_providers,
    user_credentials_name,
)

HUB = "https://hub.example.test"


def _point_at(monkeypatch, hub: str) -> str:
    """Point the SDK at ``hub`` and return the api base URL that implies.

    Patches the SERVICE CONFIG, not the environment. ``FLOWPAD_HUB_URL`` is read
    once, when ``flow_sdk.config`` is imported and `default_service_config` is
    constructed — long before any test runs — so `monkeypatch.setenv` here would
    silently change nothing and the assertions below would pass or fail against
    whatever hub this checkout happens to be configured for.
    """
    from flow_sdk.config import default_service_config

    monkeypatch.setattr(default_service_config, "flowpad_hub_url", hub, raising=False)
    return f"{hub}/api/v1"


@pytest.fixture
def hub_url(monkeypatch):
    """Point the SDK at a known hub so the resolved URLs are assertable."""
    return _point_at(monkeypatch, HUB)


# --------------------------------------------------------------- coexistence


def test_flowpad_oauth_is_a_separate_provider_from_the_api_key_login():
    """The two sign-in methods must never collapse onto one name.

    `flowpad_cloud` is the api-key login and is deliberately NOT in the registry
    (`flowpad-connection-row.tsx` renders it from its own producer). If these two
    names were ever unified, the Connections table would have no way to say which
    method is connected — and disconnecting one would read as disconnecting both.
    """
    assert FLOWPAD == "flowpad"
    assert OAuthProvider.FLOWPAD_CLOUD.value == "flowpad_cloud"
    assert get_local_provider(OAuthProvider.FLOWPAD_CLOUD.value) is None
    assert get_local_provider(FLOWPAD) is not None


def test_the_two_methods_do_not_share_a_credential():
    """Signing in one way must not overwrite the other's credential.

    The api-key login writes `UserHubCredentials` (the sod `api_key` entry); this
    grant writes the provider credential `flowpad_credentials`. Different stores,
    so connecting or disconnecting either leaves the other exactly as it was.
    """
    assert user_credentials_name(FLOWPAD) == "flowpad_credentials"


def test_flowpad_is_offered_in_connections(hub_url):
    """It must reach the Connections table, which means being publishable."""
    assert FLOWPAD in {p.name for p in publishable_local_providers()}


# ------------------------------------------------------------- the descriptor


def test_it_is_a_real_loopback_pkce_grant():
    """LOOPBACK, not CODE.

    CODE would mean "the hub runs this flow against a third party for us", which
    routes it through `prefers_hub_flow` and the hub's own connection machinery.
    Here the hub IS the authorization server, so the desktop runs the grant.
    """
    p = get_local_provider(FLOWPAD)
    assert p.kind is OAuthFlowKind.LOOPBACK
    assert p.pkce is True
    assert p.hub_required is False
    assert p.copy_hub_credential is False
    assert p.token_shape is TokenShape.CREDENTIAL_DICT


def test_it_ships_a_public_client_id_and_needs_no_setup():
    """Unlike Google/Microsoft this must work out of the box.

    A first-party desktop app is a PUBLIC client: the id is not a secret and PKCE
    is what authenticates the exchange, so there is nothing for a user to
    configure. A None default here would make the row render and then refuse to
    connect — the exact failure the descriptor system exists to prevent.
    """
    assert client_id_for(FLOWPAD) == "flowpad-desktop"


def test_client_id_is_still_overridable(monkeypatch):
    monkeypatch.setenv("FLOWPAD_OAUTH_CLIENT_ID", "other-client")
    assert client_id_for(FLOWPAD) == "other-client"


# ------------------------------------------------------- hub-derived endpoints


def test_endpoints_and_probe_follow_the_configured_hub(hub_url):
    p = get_local_provider(FLOWPAD)
    assert p.endpoints.authorize_url == f"{hub_url}/oauth/authorize"
    assert p.endpoints.token_url == f"{hub_url}/oauth/token"
    assert p.probe.url == f"{hub_url}/current-user"


def test_repointing_the_hub_repoints_the_grant(monkeypatch):
    """The URLs come from config at lookup time, not from a literal in the table.

    This is what stops one environment being hard-wired into an otherwise
    environment-free registry: an instance configured for a local hub must
    authorize against that hub, not against whichever one someone typed here.
    """
    _point_at(monkeypatch, "https://first.example.test")
    assert get_local_provider(FLOWPAD).endpoints.authorize_url.startswith("https://first.example.test")

    _point_at(monkeypatch, "https://second.example.test")
    assert get_local_provider(FLOWPAD).endpoints.authorize_url.startswith("https://second.example.test")


def test_other_providers_keep_their_literal_urls(hub_url):
    """Expansion must touch only URLs that carry the `{hub}` placeholder."""
    assert get_local_provider("anthropic").endpoints.authorize_url == "https://claude.ai/oauth/authorize"
    assert get_local_provider("github").endpoints.token_url.startswith("https://github.com/")


# ------------------------------------------------------------- authorize URL


def test_authorize_url_carries_pkce_and_state(hub_url):
    """What the hub's /oauth/authorize refuses to proceed without."""
    p = get_local_provider(FLOWPAD)
    url = do._build_authorize_url(p, "flowpad-desktop", "http://localhost:9999/callback", "st4te", "chall3nge")

    parsed = urlparse(url)
    q = {k: v[0] for k, v in parse_qs(parsed.query).items()}
    assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == f"{hub_url}/oauth/authorize"
    assert q["response_type"] == "code"
    assert q["client_id"] == "flowpad-desktop"
    assert q["redirect_uri"] == "http://localhost:9999/callback"
    assert q["state"] == "st4te"
    assert q["code_challenge"] == "chall3nge"
    assert q["code_challenge_method"] == "S256"


# -------------------------------------------------------------------- probing


def _hub_answers(monkeypatch, payload, status=200):
    """Point httpx at a canned hub response, so a probe test is three lines."""

    class _Resp:
        status_code = status

        @staticmethod
        def json():
            return payload

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def request(self, *a, **kw):
            return _Resp()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _Client())


@pytest.mark.asyncio
async def test_probe_reads_the_hubs_envelope_not_just_the_status_code(hub_url, monkeypatch):
    """`/current-user` is PUBLIC: an unaccepted token gets 200 + a fail envelope.

    A probe reading only the status code would call that verified. Reading the
    envelope also means the failure carries the hub's own message.
    """
    _hub_answers(monkeypatch, {"status": "FAIL", "data": False, "message": "Failed to resolve current user"})
    result = await run_probe(FLOWPAD, "fp_live_bogus")
    assert isinstance(result, ProbeResult)
    assert result.ok is False
    assert "Failed to resolve current user" in (result.detail or "")


@pytest.mark.asyncio
async def test_probe_passes_and_reports_the_account(hub_url, monkeypatch):
    _hub_answers(monkeypatch, {"status": "SUCCESS", "data": {"id": "u-1", "email": "a@b.test", "name": "A"}})
    result = await run_probe(FLOWPAD, "fp_live_good")
    assert result.ok is True
    assert result.identity == "a@b.test"
    assert result.account_key == "u-1"


@pytest.mark.asyncio
async def test_the_success_value_default_leaves_every_other_provider_alone(monkeypatch):
    """Slack's `{"ok": true}` must still pass now that the comparison is by value."""
    assert all(
        p.probe.success_value is True
        for p in registry.local_providers()
        if p.probe and p.name != FLOWPAD
    )
    _hub_answers(monkeypatch, {"ok": True, "user": "u", "team": "t", "team_id": "T1", "user_id": "U1"})
    assert (await run_probe("slack", "xoxp-good")).ok is True
    _hub_answers(monkeypatch, {"ok": False, "error": "invalid_auth"})
    rejected = await run_probe("slack", "xoxp-bad")
    assert rejected.ok is False and rejected.code == "invalid_auth"
