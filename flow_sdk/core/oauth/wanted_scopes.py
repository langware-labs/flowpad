"""Which scopes a connect asks for beyond a provider's base set — and why.

A provider's ``scopes`` are what every connection of it consents to. Some permissions are needed only by
some uses: writing back to Drive needs full ``drive`` where reading needs ``drive.readonly``. Those
are asked for exactly while something on this machine needs them — a data source that writes back
(not ``read_only``) and whose driver declares a ``writes`` permission on this connection — so a person
who only reads never consents to more. A local provider bounds them by its ``optional_scopes``; a hub
provider's own manifest bounds them on the hub.
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
    if local is not None:
        wanted &= set(local.optional_scopes)
        wanted -= set(local.scopes)
    return sorted(wanted)


__all__ = ["wanted_extra_scopes"]
