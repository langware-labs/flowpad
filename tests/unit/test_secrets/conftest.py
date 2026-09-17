"""An isolated DB, a temp user home and a git-backed project for the secret-store tests.

The same driver swap ``test_credential_asset`` uses: a test that saves rows must not leak them
into its neighbours, and a value must never land in the real home or the real vault.
"""
import subprocess

import pytest
import pytest_asyncio

import flow_sdk.db.drivers.db_driver as db_driver_mod
import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — registers every TypeInfo
import flow_sdk.models.entities  # noqa: F401 — registers every Entity CLASS
from flow_sdk.builtin.project import Project
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver


@pytest_asyncio.fixture
async def folder_db(tmp_path):
    cfg = DBConfig()
    cfg.database = str(tmp_path / "secrets.db")
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


def git_init(folder) -> None:
    subprocess.run(["git", "init", "-q"], cwd=folder, check=True)


@pytest.fixture
def home(folder_db, sod_env, fresh_user_scope):
    """User scope rooted at a temp folder instead of the real home."""
    fresh_user_scope.mkdir()
    return fresh_user_scope


@pytest.fixture
async def project(home, tmp_path_factory):
    # Not under ``tmp_path``: ``sod_env`` makes that folder FLOW_HOME, and a folder inside the flow
    # home is protected — never a project a working directory resolves to.
    mount = tmp_path_factory.mktemp("proj")
    git_init(mount)
    p = Project(name=str(mount))
    p.fs_storage_mount_path = str(mount)
    await p.save()
    return p


@pytest.fixture
def in_project(project, monkeypatch):
    """The working directory is the project's folder, as in a worker or a terminal there."""
    monkeypatch.chdir(project.fs_storage_mount_path)
    return project
