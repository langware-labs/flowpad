"""Registering the drivers that come from ASSETS rather than from code.

`get_driver` is a synchronous dict lookup, and it is called from synchronous
places — `sync.py`, `reflect.py`, `inbox/outbound.py`. Resolving a spec means a
database query, which is async. Rather than make the lookup async and ripple
through every caller, the registry is POPULATED ahead of the lookup:

* on every heartbeat tick, which already imports the shipped drivers, so a spec
  written or edited on disk is live within one poll cadence;
* on the create path, so a source made moments after authoring resolves its
  driver — and therefore its setup step — without waiting for a tick;
**Deliberately NOT from a post-sync hook on the type.** That was tried: it runs
inside the indexer's per-record sync, and importing the drivers package from
there — the indexer probes in worker threads — deadlocks on the import lock. A
fresh instance indexing five specs went from 3s to a 120s timeout. The cost of
not having it is at most one heartbeat, and the create path already refreshes on
demand, which is the case a person actually feels.

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

#: Spec-backed providers this process has registered. Two jobs, deliberately:
#: it suppresses a repeat log line on the once-a-minute sweep, and it is the
#: ledger `_forget` diffs against to unregister a spec that left the disk.
#: Deliberately NOT a staleness key: re-registering is a few attribute reads
#: and a dict write, and keying on a stamp is how an edited spec silently keeps
#: its old driver — the exact failure the heartbeat exists to prevent.
_REGISTERED: set[str] = set()


def _remember_builtins() -> set[str]:
    global _BUILTIN_NAMES
    if not _BUILTIN_NAMES:
        import flow_sdk.ingest.drivers  # noqa: F401, PLC0415 — register shipped drivers
        from flow_sdk.ingest.driver import DRIVERS  # noqa: PLC0415

        _BUILTIN_NAMES = set(DRIVERS.kinds())
    return _BUILTIN_NAMES


async def refresh_spec_drivers(name: Optional[str] = None) -> None:
    """Register an adapter per script-runtime spec.

    Pass `name` to resolve ONE provider — the create path knows which one it
    needs, and asking for the whole type on a request a person is waiting on is
    work for no answer.

    Never raises: a malformed spec must not stop the poller, and the source that
    needs it will report `unknown_provider`, which is a diagnosable state.
    """
    from flow_sdk.ingest.driver import register_driver  # noqa: PLC0415
    from flow_sdk.ingest.drivers.script import driver_for_spec  # noqa: PLC0415

    builtins = _remember_builtins()
    try:
        specs = await _all_specs(name)
    except Exception:  # noqa: BLE001 — absence of the table is not a poller failure
        logger.debug("[ingest] could not list data_source_spec", exc_info=True)
        return

    seen: set[str] = set()
    for row in specs:
        spec_name = str(getattr(row, "name", "") or "")
        if not spec_name:
            continue
        if spec_name in builtins:
            logger.warning(
                "[ingest] spec %r shadows a shipped driver and is ignored — rename the folder",
                spec_name,
            )
            continue
        driver = driver_for_spec(row)
        if driver is None:
            continue
        # Unconditional: an edited spec is picked up on the next sweep rather
        # than being pinned by whatever was registered first.
        register_driver(driver)
        seen.add(spec_name)
        if spec_name not in _REGISTERED:
            _REGISTERED.add(spec_name)
            logger.info("[ingest] registered authored source %r from %s", spec_name, driver.folder)

    # A spec deleted or renamed on disk must stop answering. Only on a FULL
    # sweep: a name-scoped refresh saw one row and knows nothing about the rest.
    if name is None:
        _forget(seen)


def _forget(seen: set[str]) -> None:
    """Drop adapters whose spec is gone, so a deleted source stops resolving."""
    from flow_sdk.ingest.driver import DRIVERS  # noqa: PLC0415

    for stale in _REGISTERED - seen:
        DRIVERS.unregister(stale)
        logger.info("[ingest] authored source %r is gone; unregistered", stale)
    _REGISTERED.intersection_update(seen)


async def _all_specs(name: Optional[str] = None) -> list:
    """Every script-runtime spec.

    Filtered in the query rather than in Python: this is an internal registry
    warm, and an unfiltered enumeration of a type is the shape this repo bans
    for anything user-facing. `builtin` specs need no driver anyway.
    """
    from flow_sdk.builtin.data_source_spec import (
        DataSourceSpec,  # noqa: PLC0415
        Runtime,  # noqa: PLC0415
    )

    query = {"runtime": Runtime.SCRIPT.value}
    if name:
        query["name"] = name
    return list(await DataSourceSpec.get_all(query) or [])
