"""Thin facade over the active DB driver.

Historically this module owned its own SQLAlchemy engine + session
factory in module-level globals (`_engine`, `_session_factory`). That
created a second engine on the same SQLite file in parallel with
`SQLiteDBDriver`, with separate pools and pragmas. Both engines fought
for the writer lock without knowing about each other.

Now there is exactly one engine, owned by the active DBDriver instance
(`flow_sdk.db.drivers.db_driver.get_db_driver()`). This module exposes
the historical names (`init_db`, `close_db`, `async_session`,
`reinit_db`) as thin wrappers so existing call-sites keep working
without churn.

Prefer the new public API for new code:

    from flow_sdk.db import session

    async with session() as s:
        ...
"""

import logging
import os

from flow_sdk.db import session as _unified_session
from flow_sdk.db.drivers.db_driver import _driver_instances, get_db_driver

logger = logging.getLogger(__name__)


async def init_db() -> None:
    """Initialize the active DB driver and create tables.

    Idempotent: safe to call multiple times. Subsequent calls are a no-op
    when the driver is already open (`SQLiteDBDriver.open()` early-returns).
    """
    await get_db_driver().open()
    logger.debug("Database initialized")


async def close_db() -> None:
    """Dispose the active DB driver and drop the singleton."""
    driver = _driver_instances.get("sqlite")
    if driver is not None:
        try:
            await driver.close()
        except Exception:
            pass
        _driver_instances.pop("sqlite", None)


# Backwards-compat alias for callers writing
# `from flow_sdk.db.database import async_session`. Internally delegates
# to `flow_sdk.db.session()`.
async_session = _unified_session


async def reinit_db(new_path: str) -> None:
    """Hot-swap the SQLite database to a new path without restarting the server.

    Mutates the cached ``InstanceSettings`` so ``settings.db_path`` reflects
    the new location, drops the cached driver so the next ``get_db_driver()``
    builds a fresh one bound to the new path (via the lazy resolution in
    ``SQLiteDBDriver.open``), and clears the entity caches.

    Writes nothing to ``os.environ`` — env is an input, not a channel. The
    legacy implementation wrote ``SQLITE_DATABASE_PATH`` to ``os.environ``
    and never cleared it; that permanently poisoned the process env and
    let subsequent re-resolves silently re-read the stale value.
    """
    expanded = os.path.expanduser(new_path)

    from flow_sdk.db.drivers.db_driver import db_lifecycle_guard  # noqa: PLC0415

    # Same dispose→swap-path→reinit→repoint shape as clear_all_data/restore —
    # serialize under the shared lifecycle lock so a path-switch can't straddle
    # a concurrent clear/restore (or a fresh session open) and leave two engines
    # bound to different files. The guard flags this coroutine so the nested
    # new_driver.open() / entity-cache work bypass the non-reentrant lock.
    async with db_lifecycle_guard():
        # Close the existing driver BEFORE override_db_path runs — override_db_path
        # pops the sqlite key from _driver_instances as part of its contract, so
        # if we deferred the close until after override, the driver reference
        # would be gone and the engine would leak its aiosqlite worker threads.
        driver = _driver_instances.get("sqlite")
        if driver is not None:
            try:
                await driver.close()
            except Exception:
                pass

        from flow_sdk.instance_settings import override_db_path  # noqa: PLC0415
        override_db_path(expanded)

        # Construct a fresh driver against the new ``settings.db_path``.
        new_driver = get_db_driver()
        await new_driver.open()

        # Rebind the LazyDBDriver class-level caches so future ``DBEntity._db``
        # / ``DBRelationship._db`` reads point at the new driver instead of the
        # old closed instance. Without this, the LazyDBDriver descriptor (which
        # replaced itself with the OLD driver on first access) keeps returning
        # the closed driver — same split-brain pattern as the TestClient incident
        # documented in memory/project_testclient_close_db_split_brain.md.
        from flow_sdk.db.db_entity import DBEntity  # noqa: PLC0415
        from flow_sdk.db.db_relationship import DBRelationship  # noqa: PLC0415
        DBEntity._db = new_driver
        DBRelationship._db = new_driver

        from flow_sdk.core.cache.entity_cache import entity_cache, uname_cache
        entity_cache.clear()
        uname_cache.clear()


__all__ = ["init_db", "close_db", "async_session", "reinit_db"]
