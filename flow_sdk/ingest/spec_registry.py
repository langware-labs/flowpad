"""Registering the drivers that come from ASSETS rather than from code.

`get_driver` is a synchronous dict lookup, and it is called from synchronous
places — `sync.py`, `reflect.py`, `inbox/outbound.py`. Resolving a spec means a
database query, which is async. Rather than make the lookup async and ripple
through every caller, the registry is POPULATED ahead of the lookup:

* at server startup, so the first create resolves;
* on every heartbeat tick, which already imports the shipped drivers, so a spec
  edited on disk is live within one poll cadence;
* right after a `data_source_spec` row syncs, so the common case waits for
  nothing at all.

**Builtins always win.** `register_driver` is a bare dict assignment, so a user
folder named `rss` carrying a `fetch.py` would otherwise replace `RssDriver` for
every existing RSS source on the machine. A collision is refused and logged.
"""
from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

#: Provider names owned by a shipped driver class, captured the first time a
#: refresh runs — before any adapter has been registered.
_BUILTIN_NAMES: set[str] = set()

#: `provider -> (spec id, updated_date)` for what is currently registered, so an
#: edited spec re-registers and an unchanged one does not churn.
_REGISTERED: dict[str, tuple[str, str]] = {}


def _remember_builtins() -> set[str]:
    global _BUILTIN_NAMES
    if not _BUILTIN_NAMES:
        import flow_sdk.ingest.drivers  # noqa: F401, PLC0415 — register shipped drivers
        from flow_sdk.ingest.driver import _REGISTRY  # noqa: PLC0415

        _BUILTIN_NAMES = set(_REGISTRY)
    return _BUILTIN_NAMES


async def refresh_spec_drivers(spec=None) -> int:
    """Register an adapter for every script-runtime spec. Returns how many.

    Pass one `spec` to refresh just that row (the post-sync hook); omit it to
    sweep them all (startup and the heartbeat).

    Never raises: a malformed spec must not stop the poller, and the source that
    needs it will report `unknown_provider`, which is a diagnosable state.
    """
    from flow_sdk.ingest.driver import register_driver  # noqa: PLC0415
    from flow_sdk.ingest.drivers.script import driver_for_spec  # noqa: PLC0415

    builtins = _remember_builtins()
    try:
        specs = [spec] if spec is not None else await _all_specs()
    except Exception:  # noqa: BLE001 — absence of the table is not a poller failure
        logger.debug("[ingest] could not list data_source_spec", exc_info=True)
        return 0

    count = 0
    for row in specs:
        name = str(getattr(row, "name", "") or "")
        if not name:
            continue
        if name in builtins:
            logger.warning(
                "[ingest] spec %r shadows a shipped driver and is ignored — rename the folder",
                name,
            )
            continue
        stamp = (str(getattr(row, "id", "")), str(getattr(row, "updated_date", "")))
        # An explicitly-passed row came from the post-sync hook, which fires
        # BECAUSE it changed — re-register it even if the stamp looks the same
        # (an FSRecord carries no updated_date to compare).
        if spec is None and _REGISTERED.get(name) == stamp:
            count += 1
            continue
        driver = driver_for_spec(row)
        if driver is None:
            continue
        register_driver(driver)
        _REGISTERED[name] = stamp
        count += 1
        logger.info("[ingest] registered authored source %r from %s", name, driver.folder)
    return count


async def _all_specs() -> list:
    """Every script-runtime spec.

    Filtered in the query rather than in Python: this is an internal registry
    warm, and an unfiltered enumeration of a type is the shape this repo bans
    for anything user-facing. `builtin` specs need no driver anyway.
    """
    from flow_sdk.builtin.data_source_spec import DataSourceSpec  # noqa: PLC0415

    return list(await DataSourceSpec.get_all({"runtime": "script"}) or [])


async def on_spec_synced(record) -> None:
    """`TypeInfo.post_sync_fn` for DATA_SOURCE_SPEC — re-register just this one.

    The heartbeat sweep would catch it within a cadence anyway; this closes the
    gap so a spec authored and indexed in one breath is runnable in the next.
    """
    await refresh_spec_drivers(record)


def registered_spec_providers() -> list[str]:
    """Which providers currently come from a spec. For diagnosis."""
    return sorted(_REGISTERED)
