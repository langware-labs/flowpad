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

    with_pkce = parse_qs(urlparse(do._build_authorize_url(_dummy(pkce=True), "c", "r", "s", "chal")).query)
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


# ── record_credential: the one write seam ────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_record_credential_writes_under_the_registry_name(sod_env, registered):
    """The name comes from the registry, never from the call site — a literal
    typed at the write site and resolved from the registry at the read site is a
    token nobody can find."""
    from flow_sdk.builtin.user import User
    from flow_sdk.request_context.methods import get_user_credentials

    registered(_dummy())
    user = User(name="record-cred-user")
    await user.save()

    assert await do.record_credential(user, DUMMY, "tok-1") is True
    assert await get_user_credentials(user, "dummyauth_credentials", user.id) == "tok-1"
    # …and the visibility row, without which merge_env_tables reads a genuinely
    # connected provider as MISSING.
    assert user.get_env_var("dummyauth_credentials") is not None


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_latest_login_wins(sod_env, registered):
    """Two grants for one provider: the newest value is what is held."""
    from flow_sdk.builtin.user import User
    from flow_sdk.request_context.methods import get_user_credentials

    registered(_dummy())
    user = User(name="latest-wins-user")
    await user.save()

    await do.record_credential(user, DUMMY, "tok-first")
    await do.record_credential(user, DUMMY, "tok-second")

    assert await get_user_credentials(user, "dummyauth_credentials", user.id) == "tok-second"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_an_unknown_provider_records_nothing(sod_env):
    """Refuse rather than invent a name — a credential written under a name no
    reader resolves is worse than no credential."""
    from flow_sdk.builtin.user import User

    user = User(name="unknown-provider-user")
    await user.save()

    assert await do.record_credential(user, "not-registered", "tok") is False
    assert user.get_env_var("not-registered_credentials") is None


@pytest.mark.parametrize(
    "provider",
    [p.name for p in registry.local_providers() if p.hub_required],
)
def test_a_hub_run_provider_keeps_the_same_contract(provider):
    """No local endpoints, so `prefers_hub_flow` routes the flow to the hub that
    holds the secret and the registered callback. The local row still needs a
    credential name and a probe, which are what let the desktop name, adopt and
    attach what comes back.

    Derived from the registry rather than a hand-written list: the next hub-run
    provider is covered the moment it is declared.
    """
    p = registry.get_local_provider(provider)
    assert p.endpoints is None
    assert p.kind is OAuthFlowKind.CODE
    assert p.probe is not None
    assert registry.prefers_hub_flow(provider) is True
    assert registry.user_credentials_name(provider) == f"{provider}_credentials"


def test_atlassians_probe_names_the_person_not_a_site():
    """`/me` answers for any token carrying `read:me` and needs no cloud_id,
    which is what makes it usable as a probe."""
    assert registry.get_local_provider("atlassian").probe.url == "https://api.atlassian.com/me"


@pytest.mark.parametrize(
    ("provider", "copies"),
    [("github", True), ("slack", True), ("atlassian", False), ("linear", False), ("gitlab", False)],
)
def test_a_provider_copies_its_hub_token_iff_something_local_reads_it(provider, copies):
    """`copy_hub_credential` tracks one fact: does anything on THIS machine read
    the raw token outside a request?

    github (`git push`, the `gh` capability) and slack (`SlackDriver._token()`,
    called from the request-less ingest poller) both do, so the value has to be
    copied down — with the flag False the desktop finishes a successful OAuth
    holding a visibility row and no value, and every Slack poll fails
    `no_credential` while Connections shows "Connected". The hub-run providers do not, and
    must not copy: the hub refreshes their expiring tokens and a local copy goes
    stale within the hour.
    """
    descriptor = registry.get_local_provider(provider)
    assert descriptor is not None
    assert descriptor.copy_hub_credential is copies


def test_linears_probe_is_graphql_over_get():
    """The one probe that is not a plain REST read: the query rides in the URL
    with a JSON content-type, because neither probe runner sends a body and
    Linear rejects a body-less request without that header."""
    ln = registry.get_local_provider("linear")
    assert ln.probe.method == "GET"
    assert dict(ln.probe.query) == {"query": "{ viewer { id name email } }"}
    assert dict(ln.probe.headers) == {"Content-Type": "application/json"}
