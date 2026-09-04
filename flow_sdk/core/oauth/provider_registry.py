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

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional

logger = logging.getLogger(__name__)

GITHUB = "github"
ANTHROPIC = "anthropic"
SLACK = "slack"
GOOGLE = "google"
ATLASSIAN = "atlassian"
LINEAR = "linear"
GITLAB = "gitlab"
MICROSOFT = "microsoft"


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
class OAuthProbeSpec:
    """A declarative, read-only proof that a provider token works."""

    method: str
    url: str
    query: tuple[tuple[str, str], ...] = ()
    headers: tuple[tuple[str, str], ...] = ()
    success_field: Optional[str] = None
    error_field: Optional[str] = None
    identity_fields: tuple[str, ...] = ()
    account_key_fields: tuple[str, ...] = ()
    account_key_parts: tuple[str, ...] = ()


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
    #: Send the token exchange as JSON instead of a form.
    #:
    #: RFC 6749 §4.1.3 says the token request is
    #: ``application/x-www-form-urlencoded``, and a spec-following provider
    #: (Microsoft, Google) rejects a JSON body outright — Entra answers
    #: ``AADSTS900144: the request body must contain 'grant_type'`` because it
    #: never parsed it. Anthropic's endpoint takes JSON, and it was the only
    #: local code/loopback provider for long enough that JSON became the
    #: hard-coded default. So the DEFAULT is the spec and the exception is
    #: named, rather than the other way round.
    token_request_json: bool = False
    token_shape: TokenShape = TokenShape.BEARER_STRING
    probe: Optional[OAuthProbeSpec] = None
    #: The standard route is delegated to the Hub; local endpoints/client id
    #: are therefore intentionally absent and are not publication defects.
    hub_required: bool = False
    #: Whether a Hub grant is copied into local SOD for non-Hub consumers.
    copy_hub_credential: bool = False
    #: OPTIONAL. The local SOD name for this provider's APP (bot) credential,
    #: when the provider issues a second identity alongside the user's. Slack's
    #: one OAuth returns both an `xoxb` bot token and an `xoxp` user token; the
    #: bot is who an agent should speak AS in a channel, and it is the identity
    #: `_ensure_identity` was written to stamp. None means the provider has no
    #: second identity, which is every other provider we ship.
    app_credentials_name: Optional[str] = None


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
        probe=OAuthProbeSpec(
            method="GET",
            url="https://api.github.com/user",
            identity_fields=("login", "name"),
            account_key_fields=("id",),
        ),
        copy_hub_credential=True,
    ),
    ANTHROPIC: LocalOAuthProvider(
        name=ANTHROPIC,
        # Its token endpoint takes JSON; see the field's note.
        token_request_json=True,
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
        probe=OAuthProbeSpec(
            method="GET",
            url="https://api.anthropic.com/v1/organizations/me",
            headers=(
                ("anthropic-version", "2023-06-01"),
                ("anthropic-beta", "oauth-2025-04-20"),
            ),
            identity_fields=("name", "display_name", "email"),
            account_key_fields=("id", "uuid"),
        ),
    ),
    GOOGLE: LocalOAuthProvider(
        name=GOOGLE,
        display_name="Google",
        user_credentials_name="google_credentials",
        icon="Google",
        # Google's "Desktop app" client type is exactly this grant: authorize in
        # the browser, redirect to a loopback port, exchange with PKCE.
        kind=OAuthFlowKind.LOOPBACK,
        # Read-only Drive and read-only Storage — what `GoogleDriveDriver` and
        # `GoogleCloudStorageDriver` ask for. Listed here AND in each source manifest
        # because this is what the consent screen requests while the manifest is what
        # the source declares it needs; the verify path asserts the granted set covers
        # the requested one.
        #
        # `devstorage.read_only` was missing until GCS shipped, so a Google connection
        # granted before then carries Drive only and every GCS call 403s — including the
        # bucket picker, which then reads as "this project has no buckets". Adding a
        # scope invalidates existing consent: anyone already connected reconnects once.
        scopes=(
            "https://www.googleapis.com/auth/drive.readonly",
            "https://www.googleapis.com/auth/devstorage.read_only",
        ),
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
        probe=OAuthProbeSpec(
            method="GET",
            url="https://www.googleapis.com/drive/v3/about",
            query=(("fields", "user(permissionId,displayName,emailAddress)"),),
            identity_fields=("user.emailAddress", "user.displayName"),
            account_key_fields=("user.permissionId",),
        ),
    ),
    MICROSOFT: LocalOAuthProvider(
        name=MICROSOFT,
        display_name="Microsoft",
        user_credentials_name="microsoft_credentials",
        icon="Microsoft",
        # GOOGLE's shape, NOT Slack's, and the difference is load-bearing. A
        # Teams source is POLLED, and a background poll has no request user, so
        # `credential_for` lands on the local tier and can never reach a
        # hub-held token (see its docstring). Slack gets away with a hub flow
        # because its bot token does not expire and is copied down once; a
        # Microsoft access token lasts an hour, so a copy would be stale before
        # the next poll. Entra ID supports a public client with PKCE and a
        # loopback redirect — the same desktop grant Google Drive uses — which
        # keeps the refresh token on this machine where the poller can spend it.
        kind=OAuthFlowKind.LOOPBACK,
        # `offline_access` is the one that matters: without it there is no
        # refresh token and the connection dies after an hour.
        # `ChannelMessage.Read.All` is the least-privileged delegated permission
        # that lists channel messages; `.Send` posts. Personal Microsoft
        # accounts are NOT supported by these APIs — work/school only.
        scopes=(
            "offline_access",
            "User.Read",
            "Team.ReadBasic.All",
            "Channel.ReadBasic.All",
            "ChannelMessage.Read.All",
            "ChannelMessage.Send",
        ),
        endpoints=OAuthEndpoints(
            # `common` covers any work/school tenant. A single-tenant app
            # registration replaces it with the tenant id, which is a change to
            # the app, not to this table.
            authorize_url="https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token_url="https://login.microsoftonline.com/common/oauth2/v2.0/token",
        ),
        # No default: this repo registers no Entra application. Set
        # MICROSOFT_CLIENT_ID from an app registration of type "Mobile and
        # desktop" with `http://localhost` as a redirect URI. Until then
        # `client_id_for` returns None and the flow reports a missing client
        # rather than half-running.
        client_id_env="MICROSOFT_CLIENT_ID",
        client_id_default=None,
        pkce=True,
        # access_token + refresh_token + expiry: the refresh half is what the
        # poller spends an hour from now.
        token_shape=TokenShape.CREDENTIAL_DICT,
        probe=OAuthProbeSpec(
            method="GET",
            url="https://graph.microsoft.com/v1.0/me",
            identity_fields=("userPrincipalName", "displayName"),
            account_key_fields=("id",),
        ),
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
        # Slack's token is a bearer string.
        token_shape=TokenShape.BEARER_STRING,
        probe=OAuthProbeSpec(
            method="POST",
            url="https://slack.com/api/auth.test",
            success_field="ok",
            error_field="error",
            identity_fields=("user", "team"),
            account_key_parts=("team_id", "user_id"),
        ),
        hub_required=True,
        # `SlackDriver._token()` calls `token_for(SLACK)` on every poll, from the
        # background poller, which has no request user and so cannot reach the hub
        # tier. Adoption runs once inside the wait-callback request (which can),
        # and the poller then reads local SOD.
        copy_hub_credential=True,
        # The bot half of the same grant. An agent posts AS this, not as the
        # human who connected — which is also what makes an inbound message from
        # that human read as someone else, so a reply is addressable at all.
        app_credentials_name="slack_bot_credentials",
    ),
    ATLASSIAN: LocalOAuthProvider(
        name=ATLASSIAN,
        display_name="Atlassian",
        user_credentials_name="atlassian_credentials",
        icon="Atlassian",
        # Same shape as Slack: the hub holds the client secret and the
        # registered callback URLs (exact-match, hub-hosted), so the desktop
        # can only delegate. `endpoints=None` is what routes it there.
        kind=OAuthFlowKind.CODE,
        endpoints=None,
        # Scopes are the hub plugin's; the consent screen shows that list.
        scopes=(),
        token_shape=TokenShape.BEARER_STRING,
        # `/me` answers with account_id/email/name for any token carrying
        # `read:me`. Site-scoped calls need a cloud_id and are not a probe.
        probe=OAuthProbeSpec(
            method="GET",
            url="https://api.atlassian.com/me",
            identity_fields=("email", "name"),
            account_key_fields=("account_id",),
        ),
        hub_required=True,
        # Access tokens expire hourly and the hub refreshes them; a local copy
        # would go stale within the hour, so read through the hub instead.
        copy_hub_credential=False,
    ),
    LINEAR: LocalOAuthProvider(
        name=LINEAR,
        display_name="Linear",
        user_credentials_name="linear_credentials",
        icon="Linear",
        # Hub-run code flow, like Slack and Atlassian.
        kind=OAuthFlowKind.CODE,
        endpoints=None,
        scopes=(),
        token_shape=TokenShape.BEARER_STRING,
        # GraphQL over GET: the query rides in the URL, and the JSON content-type
        # is what gets the request past Linear's CSRF guard.
        probe=OAuthProbeSpec(
            method="GET",
            url="https://api.linear.app/graphql",
            query=(("query", "{ viewer { id name email } }"),),
            headers=(("Content-Type", "application/json"),),
            identity_fields=("data.viewer.email", "data.viewer.name"),
            account_key_fields=("data.viewer.id",),
        ),
        hub_required=True,
        copy_hub_credential=False,
    ),
    GITLAB: LocalOAuthProvider(
        name=GITLAB,
        display_name="GitLab",
        user_credentials_name="gitlab_credentials",
        # lucide ships this one, so the name is all the frontend needs.
        icon="Gitlab",
        kind=OAuthFlowKind.CODE,
        endpoints=None,
        scopes=(),
        token_shape=TokenShape.BEARER_STRING,
        probe=OAuthProbeSpec(
            method="GET",
            url="https://gitlab.com/api/v4/user",
            identity_fields=("email", "username"),
            account_key_fields=("id",),
        ),
        hub_required=True,
        # Two-hour token the hub refreshes; a local copy would go stale.
        copy_hub_credential=False,
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


def publishable_local_providers() -> list[LocalOAuthProvider]:
    """Providers whose complete local connection contract is executable."""
    return [
        provider
        for provider in local_providers()
        if provider.probe is not None
        and bool(provider.user_credentials_name)
        and (
            provider.hub_required
            or (
                provider.endpoints is not None
                and bool(provider.endpoints.token_url)
                and (provider.kind == OAuthFlowKind.DEVICE or bool(provider.endpoints.authorize_url))
                and bool(client_id_for(provider.name))
            )
        )
    ]


def user_credentials_name(name: str) -> Optional[str]:
    """The SOD entry name holding this provider's user token, or ``None``.

    Callers that previously read ``oauth_providers_config_cache[p].user_credentials_name``
    and would have raised ``KeyError`` on an unknown provider should treat
    ``None`` as "not a provider we can resolve locally".
    """
    provider = get_local_provider(name)
    return provider.user_credentials_name if provider else None


def app_credentials_name(name: str) -> Optional[str]:
    """The SOD entry name holding this provider's APP (bot) token, or ``None``.

    ``None`` for every provider that issues only one identity, which is all of
    them but Slack — so a caller can ask unconditionally.
    """
    provider = get_local_provider(name)
    return provider.app_credentials_name if provider else None


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


async def credential_for(provider: str, *, user: Any = None, hub: bool = True, name: str | None = None) -> Any:
    """The stored credential for ``provider`` in whatever shape it was saved
    (GitHub: the token string; Anthropic: the normalized OAuth dict), or ``None``.

    Tiers, in order: the current request's user (re-read, so a token stored
    since the process booted is visible), then this machine's local user when
    it is a different principal, then the hub. Connection sharing copies a
    hub-held token down, so on a set-up machine it is already local, and the
    hub covers the window before a desktop has adopted it. Background contexts
    (discovery sweeps, the OAuth poll task) have no request user and land on
    the local tier. ``hub=False`` skips the hub round trip for a credential
    that is desktop-local by construction (Anthropic).

    ``user`` names ONE principal (a ``User`` or its typeid) and disables the
    chain — the publish path acts for an explicit actor, never a fallback.

    One copy, because the precedence IS the policy: it lived in six places
    (two ingest drivers, two "current user" action helpers, a publish-side
    resolver and a capability probe) and a new tier reached some of them.
    Never raises: absence is the normal case for a provider nobody connected.
    """
    # ``name`` reads a NON-default credential for the same provider — Slack's
    # bot token beside the user's. The hub tier is skipped for it: that tier
    # resolves the provider's user-token name, which is not this one.
    entry = name or user_credentials_name(provider)
    if not entry:
        return None

    from flow_sdk.builtin.user import User  # noqa: PLC0415
    from flow_sdk.request_context.methods import (  # noqa: PLC0415
        get_current_request_user_fresh,
        get_user_credentials,
    )

    async def _read(target: Any) -> Any:
        u = target if isinstance(target, User) else await User.get_by_typeid(target)
        if u is None:
            return None
        try:
            return await get_user_credentials(u, entry, u.id)
        except KeyError:  # no SOD entry — the ordinary "not connected"
            return None

    try:
        if user is not None:
            return await _read(user)
        seen: set[str] = set()
        for target in (await get_current_request_user_fresh(), await User.get_local()):
            if target is None or getattr(target, "id", None) in seen:
                continue
            seen.add(getattr(target, "id", None))
            value = await _read(target)
            if value:
                return value
    except Exception:  # noqa: BLE001
        logger.debug("%s: no local credential", provider, exc_info=True)

    # An explicit name skips the hub tier: that tier resolves the provider's
    # USER-token name, which by definition is not the one being asked for.
    if not hub or name:
        return None
    try:
        from flow_sdk.core.oauth.hub_oauth import (  # noqa: PLC0415
            hub_credential_value,
            hub_credentials_name_for,
        )

        return await hub_credential_value(hub_credentials_name_for(provider))
    except Exception:  # noqa: BLE001
        logger.debug("%s: no hub credential", provider, exc_info=True)
        return None


async def token_for(provider: str, *, user: Any = None, hub: bool = True, name: str | None = None) -> Optional[str]:
    """The bearer token for ``provider`` — ``credential_for`` unwrapped by
    ``token_from_credential`` (a dict credential yields its ``access_token``).

    ``name`` selects a non-default credential for the same provider (Slack's bot
    token beside the user's) and is passed straight through, so a caller never
    has to unwrap by hand."""
    from flow_sdk.core.oauth.provider_probe import token_from_credential  # noqa: PLC0415

    return token_from_credential(await credential_for(provider, user=user, hub=hub, name=name))
