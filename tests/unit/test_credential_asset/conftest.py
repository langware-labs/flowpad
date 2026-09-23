"""Isolated DB for credential-asset tests.

The same driver swap `test_data_source_asset` and `test_folder_source` use: a
test that mints entities through the real walker must not leak rows into its
neighbours.
"""
import subprocess

import pytest
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


@pytest.fixture
def home(folder_db, sod_env, tmp_path, monkeypatch):
    """User scope rooted at a temp folder instead of the real home."""
    import flow_sdk.builtin.asset_placement as placement
    from flow_sdk.assets.placement import Scope

    root = tmp_path / "home"
    root.mkdir()
    real = placement.root_for_scope

    def root_for_scope(scope, *, project_mount=None):
        return root if scope == Scope.USER else real(scope, project_mount=project_mount)

    monkeypatch.setattr(placement, "root_for_scope", root_for_scope)
    return root


@pytest.fixture
async def project(home, tmp_path):
    from flow_sdk.builtin.project import Project

    mount = tmp_path / "proj"
    mount.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=mount, check=True)
    p = Project(name=str(mount))
    p.fs_storage_mount_path = str(mount)
    await p.save()
    return p
