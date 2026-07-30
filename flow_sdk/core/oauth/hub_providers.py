"""Providers defined by the hub, surfaced in the local Connections tab.

Connections work **directly with the hub**: the hub owns the manifests, runs the
flows, and holds the resulting tokens. This module does not reimplement any of
that — it fetches the hub's own provider table and unions it into the local one
so the two appear as a single list.

Two things worth stating, because both are easy to get wrong:

**The hub user id is not the local user id.** The local user is the ``@local``
singleton; the cloud identity comes from ``app_config.get_user()``. Generic hub
reflection keys on ``entity.id``, which is right for a project and wrong here —
using it would query a user that does not exist on the hub.

**Local providers win a name collision.** A desktop ``github`` credential is
resolvable right here; the hub's ``github`` manifest is not. Letting the hub row
shadow the local one would send a user through a browser flow for a token they
already hold.

Every failure degrades to local-only rather than raising: the tab is worth
showing with two providers, not worth breaking because the hub is unreachable.
"""

from __future__ import annotations

import logging
from typing import Any

from flow_sdk.core.entity.entity_env.env_types import EntityEnvVars, EnvVar, EnvVarType
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

logger = logging.getLogger(__name__)



def _cloud_user_id() -> str | None:
    try:
        from flow_sdk.cli.app_config import get_user  # noqa: PLC0415

        user = get_user() or {}
        return str(user.get("id") or "") or None
    except Exception:  # noqa: BLE001
        return None


def _hub_reachable() -> bool:
    try:
        from flow_sdk.cli.auth.hub_login import is_logged_in  # noqa: PLC0415
        from flow_sdk.instance_settings.privacy_mode import is_local_mode  # noqa: PLC0415

        return bool(is_logged_in()) and not is_local_mode()
    except Exception:  # noqa: BLE001
        return False


def _row_from_hub(item: dict[str, Any]) -> EnvVar | None:
    """One hub row in the same shape the local ones use — same builder, so the
    provider-row shape has one definition rather than two."""
    from flow_sdk.core.oauth import provider_env_var  # noqa: PLC0415

    name = str(item.get("name") or "").strip()
    ref_name = str(item.get("ref_name") or "").strip()
    if not name or not ref_name:
        return None
    # The hub runs a real authorization-code grant for everything it defines.
    # Its manifest holds the scope list and the table does not publish it, so the
    # scopes stay empty rather than being guessed.
    from flow_sdk.core.oauth.provider_registry import OAuthFlowKind  # noqa: PLC0415

    return provider_env_var(name, name, ref_name, item.get("icon"), kind=OAuthFlowKind.CODE.value)


#: The hub's provider catalogue, cached per cloud user for the life of the
#: process. It is near-static — it changes when the hub gains a provider
#: manifest, not while someone is looking at a table — and it was being
#: re-fetched over the network on every read of the USER env table (every focus,
#: remount and invalidation) plus once per attach / detach / test.
#:
#: No TTL, so there is no window in which the list is knowably stale. Two things
#: keep it honest: the key is the cloud user id, so signing in as someone else
#: misses rather than reads the wrong catalogue (and while logged out there is no
#: id, so nothing is cached at all); and `invalidate_hub_providers()` is called
#: after a flow completes, which is the one moment the hub's answer changes
#: because of something we did.
_PROVIDER_CACHE: dict[str, EntityEnvVars] = {}


def invalidate_hub_providers() -> None:
    """Drop the cached catalogue. Called after a completed OAuth flow."""
    _PROVIDER_CACHE.clear()


async def hub_provider_rows() -> EntityEnvVars:
    """The hub's OAUTH_PROVIDER_ID rows, or empty when the hub is unavailable."""
    if not _hub_reachable():
        return EntityEnvVars(values=[])
    user_id = _cloud_user_id()
    if not user_id:
        logger.debug("[oauth] no cloud user id; skipping hub providers")
        return EntityEnvVars(values=[])

    cached = _PROVIDER_CACHE.get(user_id)
    if cached is not None:
        return cached

    try:
        from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

        payload = await hub_get(BuiltinEntityType.USER, user_id, action="env-var", sub_path="table")
    except Exception as e:  # noqa: BLE001
        logger.debug("[oauth] hub provider fetch failed: %s", e)
        return EntityEnvVars(values=[])

    if not isinstance(payload, dict):
        return EntityEnvVars(values=[])
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    values = data.get("values") if isinstance(data, dict) else None
    if not isinstance(values, list):
        return EntityEnvVars(values=[])

    rows = []
    for item in values:
        if not isinstance(item, dict):
            continue
        if str(item.get("var_type") or "") != EnvVarType.OAUTH_PROVIDER_ID.value:
            continue
        row = _row_from_hub(item)
        if row is not None:
            rows.append(row)
    table = EntityEnvVars(values=rows)
    _PROVIDER_CACHE[user_id] = table
    return table


def union_providers(local: EntityEnvVars, hub: EntityEnvVars) -> EntityEnvVars:
    """One row per provider, describing the flow that will ACTUALLY run.

    Local rows win on identity — the credential name has to stay the local one,
    because `git push` and the `gh` capability read GitHub's token out of local
    SOD by that name.

    But identity is not the same as the grant. When a local provider only has a
    DEVICE grant and the hub defines the same provider, the router prefers the
    hub's authorization-code flow (see `_handle_auth`) — so the row must say
    `code`, not `device`. A row advertising the grant that lost would be a table
    telling the user something the button then contradicts.

    Its scopes are cleared with it: the local list described the device app, and
    the hub's live in a manifest the table does not carry, so anything kept here
    would be stale.
    """
    from flow_sdk.core.oauth.provider_registry import OAuthFlowKind, prefers_hub_flow  # noqa: PLC0415

    by_name: dict[str, EnvVar] = {}
    for row in local.values:
        by_name[row.name.lower()] = row
    for row in hub.values:
        key = row.name.lower()
        existing = by_name.get(key)
        if existing is None:
            by_name[key] = row
            continue
        if prefers_hub_flow(existing.name):
            # Same predicate the router uses, so the advertised grant is the one
            # that will run. Scopes go with it: the local list described the
            # device app, and the hub's live in a manifest the table does not
            # carry — but the row is rebuilt per call, so nothing is lost for the
            # hub-unreachable fallback, which reads the registry directly.
            logger.debug("[oauth] %r keeps its local credential name but runs the hub's code flow", row.name)
            by_name[key] = existing.model_copy(
                update={"oauth_kind": OAuthFlowKind.CODE.value, "oauth_scopes": []}
            )
        else:
            logger.debug("[oauth] hub provider %r shadowed by the local one", row.name)
    return EntityEnvVars(values=[by_name[k] for k in sorted(by_name)])
