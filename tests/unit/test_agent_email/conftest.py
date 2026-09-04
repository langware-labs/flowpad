"""Isolated DB for the agent-mail gates."""
import pytest_asyncio

import flow_sdk.db.drivers.db_driver as db_driver_mod
import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — side-effect: register_all()
import flow_sdk.ingest.drivers  # noqa: F401 — side-effect: register_driver()
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver


@pytest_asyncio.fixture
async def mail_db(tmp_path):
    cfg = DBConfig()
    cfg.database = str(tmp_path / "agent_mail.db")
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
