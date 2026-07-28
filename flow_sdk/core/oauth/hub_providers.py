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

#: Marks a row as hub-owned so the connect path knows which counterparty to use.
HUB_ORIGIN_MARKER = "hub"


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
    name = str(item.get("name") or "").strip()
    ref_name = str(item.get("ref_name") or "").strip()
    if not name or not ref_name:
        return None
    return EnvVar(
        name=name,
        description=str(item.get("description") or f"OAuth integration for {name}"),
        var_type=EnvVarType.OAUTH_PROVIDER_ID,
        ref_type=BuiltinEntityType.USER,
        ref_name=ref_name,
        icon=item.get("icon"),
    )


async def hub_provider_rows() -> EntityEnvVars:
    """The hub's OAUTH_PROVIDER_ID rows, or empty when the hub is unavailable."""
    if not _hub_reachable():
        return EntityEnvVars(values=[])
    user_id = _cloud_user_id()
    if not user_id:
        logger.debug("[oauth] no cloud user id; skipping hub providers")
        return EntityEnvVars(values=[])

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
    return EntityEnvVars(values=rows)


def union_providers(local: EntityEnvVars, hub: EntityEnvVars) -> EntityEnvVars:
    """Local rows first; a hub row with a colliding name is dropped, not merged."""
    by_name: dict[str, EnvVar] = {}
    for row in local.values:
        by_name[row.name.lower()] = row
    for row in hub.values:
        if row.name.lower() in by_name:
            logger.debug("[oauth] hub provider %r shadowed by the local one", row.name)
            continue
        by_name[row.name.lower()] = row
    return EntityEnvVars(values=[by_name[k] for k in sorted(by_name)])
