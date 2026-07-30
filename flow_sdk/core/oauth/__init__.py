"""OAuth providers, as the env-var table sees them.

The insight this borrows from the hub: **a provider is not a second kind of
thing next to a secret — it is a row in the same table.** Each provider becomes
a synthetic ``EnvVar`` of type ``OAUTH_PROVIDER_ID``: a value-free *pointer*
whose ``ref_name`` names the user's credential entry. Running it through
``merge_env_tables`` then answers "is this provider connected?" in the same
five-state vocabulary as everything else, and the Connections tab and the env
table become one data source filtered by ``var_type``.

That is also what preserves the direction the model requires: **a connection
points at a secret; a secret does not point back.**

Providers come from ``provider_registry`` — the ones this instance can complete
a flow for on its own. (This module previously returned empty lists with a
docstring calling OAuth "cloud-only", which is why the Connections tab rendered
nothing at all.)
"""

from typing import List, Optional

from flow_sdk.core.entity.entity_env.env_table import merge_env_tables
from flow_sdk.core.entity.entity_env.env_types import EntityEnvVars, EnvVar, EnvVarType
from flow_sdk.core.oauth.provider_registry import local_providers
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class OAuthProviderInfo:
    """What a client needs to render one provider row."""

    def __init__(self, name: str = "", display_name: str = "", icon: str = ""):
        self.name = name
        self.display_name = display_name
        self.icon = icon


async def get_available_oauth_providers() -> List[OAuthProviderInfo]:
    return [
        OAuthProviderInfo(name=p.name, display_name=p.display_name, icon=p.icon or "")
        for p in local_providers()
    ]


def provider_env_var(
    name: str,
    display_name: str,
    credentials_name: str,
    icon: Optional[str],
    kind: Optional[str] = None,
    scopes: Optional[list[str]] = None,
) -> EnvVar:
    """One provider, as a value-free pointer row."""
    return EnvVar(
        name=name,
        description=f"OAuth integration for {display_name}",
        var_type=EnvVarType.OAUTH_PROVIDER_ID,
        # Points AT the user's credential entry. The credential never points back.
        ref_type=BuiltinEntityType.USER,
        ref_name=credentials_name,
        icon=icon,
        oauth_kind=kind,
        oauth_scopes=list(scopes or []),
    )


def oauth_provider_rows() -> EntityEnvVars:
    return EntityEnvVars(
        values=[
            provider_env_var(
                p.name,
                p.display_name,
                p.user_credentials_name,
                p.icon,
                kind=p.kind.value,
                scopes=list(p.scopes),
            )
            for p in local_providers()
        ]
    )


async def get_oauth_providers_as_env_table(user=None) -> EntityEnvVars:
    """The provider rows, merged against ``user``'s own table for status.

    Rows carry ``var_status``: MISSING while the user holds no credential for
    that provider, AVAILABLE once they do. Without the merge the tab could list
    providers but never say whether any were connected.

    Hub-defined providers are unioned in on top of the local ones — connections
    work directly with the hub, so its catalogue belongs in the same list. Local
    wins a name collision: a desktop credential is resolvable here and a hub one
    is not, so shadowing would send the user through a flow for a token they
    already hold.
    """
    from flow_sdk.core.oauth.hub_providers import hub_provider_rows, union_providers  # noqa: PLC0415

    providers = union_providers(oauth_provider_rows(), await hub_provider_rows())
    if user is None:
        return providers
    return merge_env_tables(providers, user.get_env_table())


async def resolve_user_credentials_name(provider: str) -> Optional[str]:
    """The SOD entry name holding ``provider``'s user token — local OR hub.

    ``provider_registry.user_credentials_name`` only knows the providers this
    instance can complete a flow for, so every hub-defined provider resolved to
    ``None`` and its attach was rejected as "Unknown OAuth provider" — even
    though the answer was sitting on the provider row all along, in ``ref_name``
    (the hub names these ``{PROVIDER}_OAUTH_USER_TOKEN``).

    Local first, for the same reason ``union_providers`` prefers local: a
    desktop credential is directly resolvable and a hub one is not, so a name
    collision must not send the user through the wrong flow.
    """
    from flow_sdk.core.oauth.provider_registry import user_credentials_name  # noqa: PLC0415

    local = user_credentials_name(provider)
    if local:
        return local

    from flow_sdk.core.oauth.hub_providers import hub_provider_rows  # noqa: PLC0415

    wanted = (provider or "").strip().lower()
    for row in (await hub_provider_rows()).values:
        if row.name.strip().lower() == wanted:
            return row.ref_name or None
    return None


def unresolved_provider_reason(provider: str) -> str:
    """Why a provider could not be resolved — in terms the user can act on.

    "Unknown OAuth provider 'slack'" is true only in the narrow sense that we
    could not find it. When the hub is down, every hub-defined provider vanishes
    from the union and reports as unknown, which sends the reader looking for a
    typo instead of at a service that is offline. The two need different words
    because they need different fixes.
    """
    from flow_sdk.core.oauth.hub_providers import _hub_reachable  # noqa: PLC0415

    # No "locally known" branch: every caller reaches here only when
    # `resolve_user_credentials_name` returned nothing, and that always yields a
    # name for a registry provider — so a local provider can never arrive here.
    if not _hub_reachable():
        # Careful with the claim: with the hub down we cannot tell a hub-defined
        # provider from one that does not exist anywhere, so do not assert it IS
        # hub-defined. Say what is certainly true — the catalogue is unavailable
        # — and let it return when the hub does.
        return (
            f"'{provider}' cannot be resolved while the hub is unreachable. "
            "Providers the hub defines are unavailable until it is back."
        )
    return f"Unknown OAuth provider '{provider}'"
