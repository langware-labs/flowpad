"""Which scopes a connect asks for beyond a provider's base set — and why.

A provider's ``scopes`` are what every connection of it consents to. Some permissions are needed only by
some uses: writing back to Drive needs full ``drive`` where reading needs ``drive.readonly``. Those
are asked for exactly while something on this machine needs them — a data source that writes back
(not ``read_only``), or a dataset whose rows live in a store of that driver (its ``location``), whose
driver declares a ``writes`` permission on this connection — so a person who only reads never consents to more. A local provider bounds them by its ``optional_scopes``; a hub
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
    from flow_sdk.permissions import row_scopes_of_driver, write_scopes_of_driver  # noqa: PLC0415

    asked = (provider or "").strip().lower()
    local = get_local_provider(asked) or next((p for p in local_providers() if (p.hub_name or "").lower() == asked), None)
    names = {asked, *([local.name.lower(), (local.hub_name or "").lower()] if local is not None else [])} - {""}
    wanted: set[str] = set()
    holding = await _drivers_holding_rows()
    # Only the drivers that write through this connection, then whether any of their sources writes back.
    def for_this(by_connector: dict[str, list[str]]) -> list[str]:
        return [s for connector, listed in by_connector.items() if connector.lower() in names for s in listed]

    for driver in DRIVERS.kinds():
        if driver in holding:
            wanted.update(for_this(row_scopes_of_driver(driver)))
            continue
        scopes = for_this(write_scopes_of_driver(driver))
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


async def _drivers_holding_rows() -> set[str]:
    """The drivers whose stores hold a dataset's rows on this machine (``location`` ``<driver>:<target>``,
    or a record system that is not ``read_only``): keeping rows there writes."""
    from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415
    from flow_sdk.datasets.locations import declared, parse  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

    try:
        # Only the datasets that name a location: one without keeps its rows locally.
        placed = QueryFilter(match=ExpressionNode(op=QueryOp.IS_NOT_NULL, operands=["location"]))
        in_source = QueryFilter(match=ExpressionNode(op=QueryOp.IS_NOT_NULL, operands=["data_source"]))
        datasets = [*(await Dataset.get_all(placed) or []), *(await Dataset.get_all(in_source) or [])]
    except Exception:  # noqa: BLE001 — a connect never fails because this could not be asked
        logger.warning("[oauth] could not list datasets for their locations' scopes", exc_info=True)
        return set()
    out: set[str] = set()
    for dataset in datasets:
        try:
            # The DECLARED place, even while its source is not set up: connecting is what sets it up.
            location = parse(declared(dataset.asset_ref, dataset.data_source, dataset.path, dataset.location)
                             if getattr(dataset, "asset_ref", None) else getattr(dataset, "location", None))
        except ValueError:
            continue
        if location.remote and not location.read_only:
            out.add(location.driver)
    return out


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
