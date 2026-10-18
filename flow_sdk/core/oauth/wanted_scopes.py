"""Which scopes a connect asks for beyond a provider's base set — and why.

A provider's ``scopes`` are what every connection of it consents to. Some permissions are needed only by
some uses: writing back to Drive needs full ``drive`` where reading needs ``drive.readonly``. Those
are asked for exactly while something on this machine needs them — a data source that writes back
(not ``read_only``) and whose driver declares a ``writes`` permission on this connection — so a person
who only reads never consents to more. A local provider bounds them by its ``optional_scopes``; a hub
provider's own manifest bounds them on the hub.

A declared credential whose ONE_OF group offers a sign-in with this provider as one of its ways wants that
way's scopes too, whichever way was chosen before: connecting is how a person switches to that way.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


async def wanted_extra_scopes(provider: str) -> list[str]:
    """The scopes beyond ``provider``'s base set that this machine's data sources need now, sorted."""
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.core.oauth.provider_registry import get_local_provider, local_providers  # noqa: PLC0415
    from flow_sdk.ingest.driver_runtime import DRIVERS  # noqa: PLC0415
    from flow_sdk.permissions import write_scopes_of_driver  # noqa: PLC0415

    asked = (provider or "").strip().lower()
    local = get_local_provider(asked) or next((p for p in local_providers() if (p.hub_name or "").lower() == asked), None)
    names = {asked, *([local.name.lower(), (local.hub_name or "").lower()] if local is not None else [])} - {""}
    wanted: set[str] = set()
    # Only the drivers that write through this connection, then whether any of their sources writes back.
    for driver in DRIVERS.kinds():
        scopes = [s for connector, listed in write_scopes_of_driver(driver).items() if connector.lower() in names for s in listed]
        if not scopes:
            continue
        try:
            sources = await DataSource.get_all({"provider": driver})
        except Exception:  # noqa: BLE001 — a connect never fails because this could not be asked
            logger.warning("[oauth] could not list %s sources for %s's scopes", driver, provider, exc_info=True)
            continue
        if any(not getattr(source, "read_only", False) for source in sources):
            wanted.update(scopes)
    wanted.update(await _credential_way_scopes(names))
    if local is not None:
        wanted &= set(local.optional_scopes)
        wanted -= set(local.scopes)
    return sorted(wanted)


async def _credential_way_scopes(names: set[str]) -> set[str]:
    """The scopes of each declared credential's oauth way through one of ``names``. Only this machine's
    declarations — a shipped template is never asked: it declares nothing."""
    from flow_sdk.builtin.credential import Credential  # noqa: PLC0415
    from flow_sdk.schema.data_spec.credential_contract import SCOPE_PROJECT, SCOPE_USER  # noqa: PLC0415

    try:  # a ONE_OF way lives on an env credential
        rows = [row for scope in (SCOPE_PROJECT, SCOPE_USER) for row in await Credential.get_all({"kind": "env", "scope": scope})]
    except Exception:  # noqa: BLE001 — a connect never fails because this could not be asked
        logger.warning("[oauth] could not list credentials for %s's scopes", sorted(names), exc_info=True)
        return set()
    return {
        scope
        for row in rows
        for var in (row.vars or {}).values()
        if var.is_oauth and var.provider in names
        for scope in var.scopes
    }


__all__ = ["wanted_extra_scopes"]
