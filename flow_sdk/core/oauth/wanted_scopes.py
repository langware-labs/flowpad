"""Which scopes ONE use point asks for beyond its connection's own set, and through which scope group.

A connection's own scopes are what every connect of it consents to. Some permissions are needed only by
some uses: writing back to Drive needs full ``drive`` where reading needs ``drive.readonly``. A connect
asks for exactly what the data source it was started from needs — it writes back (not ``read_only``), or
its store keeps a dataset's rows — and nothing another source needs. A local provider bounds the extra by
its ``optional_scopes``; a hub provider's own manifest bounds it on the hub.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


async def use_point(provider: str, source_id: str) -> tuple[str, list[str]]:
    """``(scope group, extra scopes)`` of the data source a connect is for — one read of the source."""
    source = await _source(source_id)
    return (await _group_of(source), await _scopes_of(provider, source)) if source is not None else ("", [])


async def scopes_for_source(provider: str, source_id: str) -> list[str]:
    """The scopes beyond ``provider``'s own set that the data source ``source_id`` needs, sorted.
    ``[]`` for no source, an unknown one, or one that only reads."""
    return (await use_point(provider, source_id))[1]


async def group_for_source(source_id: str) -> str:
    """The connector scope group the data source ``source_id`` reads through (its driver's ``auth.group``)."""
    return (await use_point("", source_id))[0]


async def _source(source_id: str):
    if not source_id:
        return None
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    try:
        return await DataSource.get_by_id(source_id)
    except Exception:  # noqa: BLE001 — a connect never fails because this could not be asked
        logger.warning("[oauth] could not read source %s for its scopes", source_id, exc_info=True)
        return None


async def _group_of(source) -> str:
    from flow_sdk.builtin.readiness import auth_of  # noqa: PLC0415

    return str(getattr(await auth_of(source), "group", "") or "")


async def _scopes_of(provider: str, source) -> list[str]:
    if getattr(source, "read_only", False):
        return []
    from flow_sdk.core.oauth.provider_registry import get_local_provider, local_providers  # noqa: PLC0415
    from flow_sdk.permissions import row_scopes_of_driver, write_scopes_of_driver  # noqa: PLC0415

    asked = (provider or "").strip().lower()
    local = get_local_provider(asked) or next((p for p in local_providers() if (p.hub_name or "").lower() == asked), None)
    names = {asked, *([local.name.lower(), (local.hub_name or "").lower()] if local is not None else [])} - {""}
    driver = str(source.provider or "")
    by_connector = row_scopes_of_driver(driver) if await _holds_rows(source) else write_scopes_of_driver(driver)
    wanted = {s for connector, listed in by_connector.items() if connector.lower() in names for s in listed}
    if local is not None:
        wanted &= set(local.optional_scopes)
        wanted -= set(local.scopes)
    return sorted(wanted)


async def _holds_rows(source) -> bool:
    """Whether a dataset keeps its rows in ``source``'s store: keeping rows there writes."""
    from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415

    if not source.name:
        return False
    try:
        return bool(await Dataset.get_all({"data_source": str(source.name)}))
    except Exception:  # noqa: BLE001 — a connect never fails because this could not be asked
        logger.warning("[oauth] could not list datasets kept in %s", source.id, exc_info=True)
        return False


__all__ = ["group_for_source", "scopes_for_source", "use_point"]
