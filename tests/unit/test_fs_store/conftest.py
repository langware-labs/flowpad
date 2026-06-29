"""Shared setup for fs_store unit tests.

Tests in this package construct ``FSIndexer`` directly and exercise the type
registry without booting the server. Production runs the declarative type-info
registrations at startup (``flow_sdk/server/app.py`` imports
``flow_sdk.fs_store.indexer.registrations``, which runs ``register_all()``).

Importing that module here once per session reproduces the same init, so
``SchemaRegistry.get("markdown")`` etc. resolve — without it the indexer walk
finds no registered type and skips every record.
"""
import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — side-effect: register_all()

import flow_sdk.db.drivers.db_driver as db_driver_mod
import pytest_asyncio
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver


@pytest_asyncio.fixture
async def sync_db(tmp_path):
    """Isolated SQLite driver bound to ``Entity`` for disk↔DB sync tests.

    Lifted from ``test_record_sync.py`` so the fs_store sync tests share one
    definition instead of each re-rolling the driver swap + teardown restore.
    """
    cfg = DBConfig()
    cfg.database = str(tmp_path / "fs_store_sync.db")
    driver = SQLiteDBDriver(cfg)
    await driver.open()

    old_instances = db_driver_mod._driver_instances.copy()
    db_driver_mod._driver_instances["sqlite"] = driver
    old_db = Entity.__dict__.get("_db")
    Entity._db = driver

    yield driver

    db_driver_mod._driver_instances.clear()
    db_driver_mod._driver_instances.update(old_instances)
    if old_db is None:
        if "_db" in Entity.__dict__:
            delattr(Entity, "_db")
    else:
        Entity._db = old_db
    await driver.close()
