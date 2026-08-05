"""A provider is a dict entry — the acceptance test for the descriptor.

`get_desktop_oauth_auth_url` used to compare `provider` against the literals
"github" and "anthropic", so a provider could be registered, render a row in
Connections, and then fail the moment anyone clicked Connect. These tests pin
the replacement: what runs comes from `LocalOAuthProvider.kind`, where it goes
comes from `.endpoints`, and neither mentions a provider by name.

They register a SYNTHETIC provider, so a pass here means a real third provider
needs no code in the flow at all.
"""

import asyncio
from urllib.parse import parse_qs, urlparse

import pytest

from flow_sdk.app.actions import desktop_oauth as do
from flow_sdk.core.oauth import provider_registry as registry
from flow_sdk.core.oauth.provider_registry import (
    LocalOAuthProvider,
    OAuthEndpoints,
    OAuthFlowKind,
    TokenShape,
)

DUMMY = "dummyauth"


def _dummy(**over) -> LocalOAuthProvider:
    base = dict(
        name=DUMMY,
        display_name="Dummy Auth",
        user_credentials_name="dummyauth_credentials",
        kind=OAuthFlowKind.LOOPBACK,
        scopes=("read", "write"),
        endpoints=OAuthEndpoints(
            authorize_url="https://dummy.test/authorize",
            token_url="https://dummy.test/token",
        ),
        client_id_env="DUMMYAUTH_CLIENT_ID",
        client_id_default="dummy-client",
        token_shape=TokenShape.BEARER_STRING,
    )
    base.update(over)
    return LocalOAuthProvider(**base)


@pytest.fixture
def registered(monkeypatch):
    """Register providers for one test. `_PROVIDERS` is a module dict, so this
    is the seam — and monkeypatch guarantees the real registry is restored."""

    def _register(provider: LocalOAuthProvider) -> LocalOAuthProvider:
        monkeypatch.setitem(registry._PROVIDERS, provider.name, provider)
        return provider

    return _register


# ── the authorize URL ────────────────────────────────────────────────────────


def test_authorize_url_is_built_from_the_descriptor():
    url = do._build_authorize_url(_dummy(), "cid", "http://localhost:9/callback", "st8")
    parsed = urlparse(url)
    assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == "https://dummy.test/authorize"

    q = parse_qs(parsed.query)
    assert q["client_id"] == ["cid"]
    assert q["state"] == ["st8"]
    assert q["response_type"] == ["code"]
    # Round-trips through parse_qs, which is the proof it was encoded properly —
    # the hand-rolled builder this replaced quoted two params and joined the rest raw.
    assert q["redirect_uri"] == ["http://localhost:9/callback"]
    assert q["scope"] == ["read write"]


def test_pkce_params_appear_only_when_the_descriptor_asks():
    without = parse_qs(urlparse(do._build_authorize_url(_dummy(), "c", "r", "s", "chal")).query)
    assert "code_challenge" not in without

    with_pkce = parse_qs(
        urlparse(do._build_authorize_url(_dummy(pkce=True), "c", "r", "s", "chal")).query
    )
    assert with_pkce["code_challenge"] == ["chal"]
    assert with_pkce["code_challenge_method"] == ["S256"]


def test_provider_specific_params_do_not_leak_to_other_providers():
    """Anthropic sends a bare `code=true`. A provider that would reject it must
    never see it — which is why it lives on the descriptor, not in the builder."""
    plain = parse_qs(urlparse(do._build_authorize_url(_dummy(), "c", "r", "s")).query)
    assert "code" not in plain

    quirky = _dummy(extra_authorize_params=(("code", "true"),))
    assert parse_qs(urlparse(do._build_authorize_url(quirky, "c", "r", "s")).query)["code"] == ["true"]


# ── dispatch ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_registered_provider_can_start_a_flow_with_no_code_change(registered):
    """The whole point: endpoints in a dict entry are enough to run a grant."""
    registered(_dummy())
    result = await do.get_desktop_oauth_auth_url(DUMMY, "user-1")
    assert result.status == "SUCCESS", result.message

    data = result.data
    assert data["kind"] == "loopback"
    assert data["url"].startswith("https://dummy.test/authorize?")
    state = data["state"]
    try:
        session = do._desktop_oauth_sessions[state]
        assert session.provider == DUMMY
        assert data["port"] and f":{data['port']}/callback" in session.redirect_uri
    finally:
        session = do._desktop_oauth_sessions.pop(state, None)
        if session and session.callback_server:
            session.callback_server.cancel()
            await asyncio.gather(session.callback_server, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_provider_with_no_endpoints_is_refused_not_crashed(registered):
    """A hub-only provider (Slack's shape) keeps its Connections row and routes
    to the hub; it simply has no local flow. That must read as 'not supported',
    not as an AttributeError on None."""
    registered(_dummy(endpoints=None))
    result = await do.get_desktop_oauth_auth_url(DUMMY, "user-1")
    assert result.status != "SUCCESS"
    assert "not supported" in result.message


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_an_unregistered_provider_is_refused():
    result = await do.get_desktop_oauth_auth_url("nobody-registered-this", "user-1")
    assert result.status != "SUCCESS"


# ── the descriptor mirrors what the module used to hardcode ─────────────────


def test_shipped_providers_kept_their_endpoints_verbatim():
    """The migration must not have retyped a URL. These are the values that were
    module constants in desktop_oauth before the descriptor existed."""
    gh = registry.get_local_provider("github")
    assert gh.endpoints.device_code_url == "https://github.com/login/device/code"
    assert gh.endpoints.token_url == "https://github.com/login/oauth/access_token"
    assert gh.endpoints.device_grant == "urn:ietf:params:oauth:grant-type:device_code"
    assert gh.scopes == ("repo", "read:org")
    assert gh.kind is OAuthFlowKind.DEVICE

    an = registry.get_local_provider("anthropic")
    assert an.endpoints.authorize_url == "https://claude.ai/oauth/authorize"
    assert an.endpoints.token_url == "https://console.anthropic.com/v1/oauth/token"
    assert an.scopes == ("user:profile", "user:inference")
    assert an.pkce is True
    assert an.token_shape is TokenShape.CREDENTIAL_DICT


def test_client_id_prefers_the_env_override(monkeypatch):
    monkeypatch.setenv("GITHUB_CLIENT_ID", "from-env")
    assert registry.client_id_for("github") == "from-env"
    monkeypatch.delenv("GITHUB_CLIENT_ID")
    assert registry.client_id_for("github") == "Ov23li9fNEH5ulTFINOZ"
    assert registry.client_id_for("not-a-provider") is None
