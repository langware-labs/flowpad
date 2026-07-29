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
from typing import Optional

GITHUB = "github"
ANTHROPIC = "anthropic"


@dataclass(frozen=True)
class LocalOAuthProvider:
    """A provider this instance can complete an OAuth flow for by itself."""

    name: str
    display_name: str
    user_credentials_name: str
    icon: Optional[str] = None


_PROVIDERS: dict[str, LocalOAuthProvider] = {
    GITHUB: LocalOAuthProvider(
        name=GITHUB,
        display_name="GitHub",
        user_credentials_name="github_credentials",
        icon="Github",
    ),
    ANTHROPIC: LocalOAuthProvider(
        name=ANTHROPIC,
        display_name="Anthropic",
        user_credentials_name="anthropic_credentials",
        icon="Sparkles",
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
