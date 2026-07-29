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
(``desktop_oauth._save_github_token_to_sod``) and ``anthropic_credentials``
(``desktop_oauth.ANTHROPIC_CREDENTIALS_NAME``).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional

GITHUB = "github"
ANTHROPIC = "anthropic"


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


@dataclass(frozen=True)
class LocalOAuthProvider:
    """A provider this instance can complete an OAuth flow for by itself."""

    name: str
    display_name: str
    user_credentials_name: str
    icon: Optional[str] = None
    kind: OAuthFlowKind = OAuthFlowKind.LOOPBACK
    scopes: tuple[str, ...] = ()


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
    ),
    ANTHROPIC: LocalOAuthProvider(
        name=ANTHROPIC,
        display_name="Anthropic",
        user_credentials_name="anthropic_credentials",
        icon="Sparkles",
        kind=OAuthFlowKind.LOOPBACK,
        scopes=("user:profile", "user:inference"),
    ),
}


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
