"""Isolated DB for credential-asset tests.

The same driver swap `test_data_source_asset` and `test_folder_source` use: a
test that mints entities through the real walker must not leak rows into its
neighbours.
"""
import pytest_asyncio

import flow_sdk.db.drivers.db_driver as db_driver_mod
import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — registers every TypeInfo
import flow_sdk.models.entities  # noqa: F401 — registers every Entity CLASS (asset_owner_classes)
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver


@pytest_asyncio.fixture
async def folder_db(tmp_path):
    """Isolated driver bound to ``Entity`` — same swap/restore as fs_store."""
    cfg = DBConfig()
    cfg.database = str(tmp_path / "credential_asset.db")
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
