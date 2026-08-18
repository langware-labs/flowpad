"""Locally-known OAuth providers.

The hub discovers providers by walking plugin manifests and caching them in
``oauth_providers_config_cache``. None of that machinery exists here — no
``PluginManifest``, no ``FunctionCapability``, no ``external_apis/oauth_lib``.
What the rest of the code actually needs from that cache is one mapping:

    provider name -> the name of the SOD entry holding the user's token

This module is that mapping, for the providers this instance can complete a
flow for on its own (see ``flow_sdk/app/actions/desktop_oauth.py``). Providers
defined by the hub are unioned in on top of these at a later layer; when the
two collide the local entry wins, because a locally-held token is directly
resolvable and a hub-held one is not.

``user_credentials_name`` must match what the desktop OAuth flows actually
write, or a connected provider reads as MISSING: ``github_credentials``
(both written through ``desktop_oauth.record_credential``) and ``anthropic_credentials``
(``desktop_oauth.ANTHROPIC_CREDENTIALS_NAME``).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional

GITHUB = "github"
ANTHROPIC = "anthropic"
SLACK = "slack"
GOOGLE = "google"


class OAuthFlowKind(str, Enum):
    """Which OAuth grant a provider's flow uses.

    Surfaced to the user, because the three are not interchangeable from where
    they sit: a code grant hands the browser to the provider and comes back with
    a full-scope token, while a device grant makes them retype a code and — for
    GitHub — is limited to what a device-flow app is registered for.
    """

    #: Authorization code, redirect handled by the hub. The real thing.
    CODE = "code"
    #: Authorization code + PKCE, redirect to a loopback port on this machine.
    #: Also a real code grant; the redirect target is what differs.
    LOOPBACK = "loopback"
    #: RFC 8628 device grant — a user code typed into the provider's site.
    DEVICE = "device"


class TokenShape(str, Enum):
    """What a provider's token response becomes once stored.

    Providers do not agree, and the disagreement is load-bearing: GitHub's SOD
    entry is the token string, Anthropic's is the whole normalized response
    (``access_token``, ``refresh_token``, ``expires_at``, identity fields). This
    is the ONE thing that stays provider-shaped after the flow is generic — and
    it is selected by data rather than by a name comparison. See
    ``provider_probe.token_from_credential``, which exists to read both.
    """

    #: The stored value IS the bearer token.
    BEARER_STRING = "bearer_string"
    #: The stored value is a dict carrying the token plus refresh/identity.
    CREDENTIAL_DICT = "credential_dict"


@dataclass(frozen=True)
class OAuthEndpoints:
    """Where a provider's flow actually goes.

    Nested rather than flattened onto the provider because a device grant and a
    code grant do not have the same URLs — a flat descriptor would carry three
    ``None``s for every entry and invite "which of these apply to me?" at each
    call site. Which ones are set is implied by ``LocalOAuthProvider.kind``.
    """

    token_url: str
    #: CODE / LOOPBACK grants.
    authorize_url: Optional[str] = None
    #: DEVICE grant (RFC 8628).
    device_code_url: Optional[str] = None
    device_grant: Optional[str] = None


@dataclass(frozen=True)
class LocalOAuthProvider:
    """A provider this instance can complete an OAuth flow for by itself."""

    name: str
    display_name: str
    user_credentials_name: str
    icon: Optional[str] = None
    kind: OAuthFlowKind = OAuthFlowKind.LOOPBACK
    scopes: tuple[str, ...] = ()

    #: Where the flow goes. ``None`` means "only the hub can run this one" — the
    #: presence of endpoints IS the predicate that used to be a comparison
    #: against the literals "github"/"anthropic" in `get_desktop_oauth_auth_url`.
    #: A provider with a row here but no endpoints still renders in Connections
    #: and still routes to the hub; it just cannot start a flow locally.
    endpoints: Optional[OAuthEndpoints] = None
    #: Env var that overrides the client id, and the fallback baked in here.
    client_id_env: Optional[str] = None
    client_id_default: Optional[str] = None
    #: Whether the authorize step sends a PKCE challenge.
    pkce: bool = False
    #: Provider-specific authorize params that must NOT leak to other providers
    #: (Anthropic sends a bare ``code=true``). Tuple-of-tuples to keep the
    #: dataclass frozen and hashable.
    extra_authorize_params: tuple[tuple[str, str], ...] = ()
    token_shape: TokenShape = TokenShape.BEARER_STRING


_PROVIDERS: dict[str, LocalOAuthProvider] = {
    GITHUB: LocalOAuthProvider(
        name=GITHUB,
        display_name="GitHub",
        user_credentials_name="github_credentials",
        icon="Github",
        # The DESKTOP-only grant. Preferred only when the hub cannot run the real
        # code flow — see `_handle_auth`.
        kind=OAuthFlowKind.DEVICE,
        scopes=("repo", "read:org"),
        # No client_secret — register an OAuth App, enable Device Flow, then set
        # GITHUB_CLIENT_ID or replace the default. (flowpad.ai - dev, langware-labs)
        endpoints=OAuthEndpoints(
            token_url="https://github.com/login/oauth/access_token",
            device_code_url="https://github.com/login/device/code",
            device_grant="urn:ietf:params:oauth:grant-type:device_code",
        ),
        client_id_env="GITHUB_CLIENT_ID",
        client_id_default="Ov23li9fNEH5ulTFINOZ",
        token_shape=TokenShape.BEARER_STRING,
    ),
    ANTHROPIC: LocalOAuthProvider(
        name=ANTHROPIC,
        display_name="Anthropic",
        user_credentials_name="anthropic_credentials",
        icon="ClaudeCode",
        kind=OAuthFlowKind.LOOPBACK,
        scopes=("user:profile", "user:inference"),
        endpoints=OAuthEndpoints(
            authorize_url="https://claude.ai/oauth/authorize",
            token_url="https://console.anthropic.com/v1/oauth/token",
        ),
        client_id_env="ANTHROPIC_CLIENT_ID",
        client_id_default="9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        pkce=True,
        # Anthropic's authorize step wants a bare `code=true` alongside
        # `response_type=code`. Provider-specific and must not leak.
        extra_authorize_params=(("code", "true"),),
        token_shape=TokenShape.CREDENTIAL_DICT,
    ),
    GOOGLE: LocalOAuthProvider(
        name=GOOGLE,
        display_name="Google",
        user_credentials_name="google_credentials",
        icon="Google",
        # Google's "Desktop app" client type is exactly this grant: authorize in
        # the browser, redirect to a loopback port, exchange with PKCE.
        kind=OAuthFlowKind.LOOPBACK,
        # Read-only Drive, which is all `GoogleDriveDriver` asks for. Listed here
        # AND in the source manifest because this is what the consent screen
        # requests while the manifest is what the source declares it needs; the
        # verify path asserts the granted set covers the requested one.
        scopes=("https://www.googleapis.com/auth/drive.readonly",),
        endpoints=OAuthEndpoints(
            authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
            token_url="https://oauth2.googleapis.com/token",
        ),
        # No default: unlike GitHub and Anthropic, this repo has no registered
        # Google client to fall back on. Set GOOGLE_CLIENT_ID from a Google Cloud
        # OAuth client of type "Desktop app". Until then `client_id_for` returns
        # None and the flow reports a missing client instead of half-running.
        client_id_env="GOOGLE_CLIENT_ID",
        client_id_default=None,
        pkce=True,
        # Google returns access_token + refresh_token + expiry, and the refresh
        # token is the half that matters — an access token lasts an hour.
        token_shape=TokenShape.CREDENTIAL_DICT,
    ),
    SLACK: LocalOAuthProvider(
        name=SLACK,
        display_name="Slack",
        user_credentials_name="slack_credentials",
        icon="Slack",
        # The hub runs this one: it holds the client secret, and Slack matches
        # the redirect URI against the app's registered
        # `<hub>/api/v1/graph/oauth/slack/callback`. A loopback port could never
        # be registered, so `endpoints` is None and `prefers_hub_flow` routes it.
        kind=OAuthFlowKind.CODE,
        endpoints=None,
        # Scopes live in the hub's plugin manifest, which is what actually asks
        # for them. Publishing a second list here would drift from the consent
        # screen the user really sees.
        scopes=(),
        # The entry exists so `_adopt_hub_credential` will copy the hub's token
        # into local SOD — without it the desktop ends a successful flow holding
        # a row and nothing else. Slack's token is a bearer string.
        token_shape=TokenShape.BEARER_STRING,
    ),
}


def client_id_for(name: str) -> Optional[str]:
    """A provider's OAuth client id: env override, else the registry default.

    One function instead of `_get_<provider>_client_id` per provider, so a new
    provider's client id is a data change like everything else about it.
    """
    import os  # noqa: PLC0415

    provider = get_local_provider(name)
    if provider is None:
        return None
    if provider.client_id_env:
        override = os.getenv(provider.client_id_env)
        if override:
            return override
    return provider.client_id_default


def get_local_provider(name: str) -> Optional[LocalOAuthProvider]:
    """Look up a provider by name, case-insensitively. ``None`` when unknown."""
    return _PROVIDERS.get((name or "").strip().lower())


def local_providers() -> list[LocalOAuthProvider]:
    """Every locally-known provider, in a stable order."""
    return [_PROVIDERS[name] for name in sorted(_PROVIDERS)]


def user_credentials_name(name: str) -> Optional[str]:
    """The SOD entry name holding this provider's user token, or ``None``.

    Callers that previously read ``oauth_providers_config_cache[p].user_credentials_name``
    and would have raised ``KeyError`` on an unknown provider should treat
    ``None`` as "not a provider we can resolve locally".
    """
    provider = get_local_provider(name)
    return provider.user_credentials_name if provider else None


def prefers_hub_flow(name: str) -> bool:
    """Whether this provider should run its flow on the hub when one is available.

    True for a provider we do not know at all, for one we can only complete with
    a DEVICE grant, and for one that has NO local endpoints — Slack, whose client
    secret and registered redirect URI both live on the hub. False for a local
    code grant (Anthropic's loopback), which is already the real thing.

    The endpoints clause is what lets a hub-run provider still have a registry
    entry. That entry is not decoration: `_adopt_hub_credential` copies a
    hub-held token into local SOD only for a provider it can look up, so without
    one the desktop finishes the flow holding a row and no token.

    The ONE encoding of that rule. `_handle_auth` routes by it and the provider
    row derives its advertised grant from it — written twice, the table would
    eventually claim a grant the button does not run.
    """
    local = get_local_provider(name)
    if local is None:
        return True
    return local.endpoints is None or local.kind == OAuthFlowKind.DEVICE


async def token_for(provider: str) -> Optional[str]:
    """This machine's bearer token for ``provider``, or ``None``.

    Local SOD first, then the hub. That order is not arbitrary: connection
    sharing copies a hub-held token down, so on a set-up machine it is already
    local, and the hub covers the window before a desktop has adopted it.

    One copy, because the precedence IS the policy. It lived twice — once in
    `SlackDriver._token` and once in `GoogleDriveDriver._token` — and a third
    connector would have copied it again, so a change to the order, or a new
    fallback tier, would have reached one driver and not the others.

    Absence is the normal case for a provider nobody connected, so neither
    lookup failing is an error worth raising.
    """
    import logging  # noqa: PLC0415

    from flow_sdk.core.oauth.provider_probe import token_from_credential  # noqa: PLC0415

    logger = logging.getLogger(__name__)
    name = user_credentials_name(provider)

    try:
        from flow_sdk.builtin.user import User  # noqa: PLC0415
        from flow_sdk.request_context.methods import get_user_credentials  # noqa: PLC0415

        user = await User.get_local()
        if user is not None and name:
            token = token_from_credential(await get_user_credentials(user, name, user.id))
            if token:
                return token
    except Exception:  # noqa: BLE001
        logger.debug("%s: no local credential", provider, exc_info=True)

    try:
        from flow_sdk.core.oauth.hub_oauth import (  # noqa: PLC0415
            hub_credential_value,
            hub_credentials_name_for,
        )

        return token_from_credential(await hub_credential_value(hub_credentials_name_for(provider)))
    except Exception:  # noqa: BLE001
        logger.debug("%s: no hub credential", provider, exc_info=True)
        return None
