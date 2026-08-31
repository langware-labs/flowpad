"""Shared setup for the folder-source matrix.

Two things this package cannot run without, both lifted from
``tests/unit/test_fs_store/conftest.py`` rather than re-rolled:

* the declarative type-info registrations, whose import side-effect is what
  makes ``SchemaRegistry.get("markdown")`` resolve. Without it every path
  handed to ``reindex_paths`` finds no owning type and is silently skipped —
  the tests pass vacuously, which is the failure mode worth spending an import
  to avoid;
* an isolated SQLite driver bound to ``Entity``, so a matrix that mints and
  deletes entities cannot leak rows into its neighbours.
"""
import pytest
import pytest_asyncio

import flow_sdk.db.drivers.db_driver as db_driver_mod
import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — side-effect: register_all()
import flow_sdk.ingest.drivers  # noqa: F401 — side-effect: register_driver() for every shipped driver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.project import Project
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver
from flow_sdk.ingest.reflect import ReflectMode


@pytest_asyncio.fixture
async def folder_db(tmp_path):
    """Isolated driver bound to ``Entity`` — same swap/restore as fs_store."""
    cfg = DBConfig()
    cfg.database = str(tmp_path / "folder_source.db")
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
def watched(tmp_path):
    """The directory the source watches — where CRUD happens."""
    d = tmp_path / "watched"
    d.mkdir()
    return d


@pytest.fixture
def project(tmp_path):
    """The directory reflected assets land in."""
    d = tmp_path / "project"
    d.mkdir()
    return d


@pytest.fixture
def in_workspace(tmp_path, monkeypatch):
    """Run with cwd at the temp workspace.

    ``Entity.from_record`` infers ``scope`` from the asset path via
    ``_scope_from_path``, which returns ``"project"`` only for paths under
    ``Path.cwd()``. Without this, every asset lands ``scope=""`` — and
    ``apply_scope_filter`` DROPS an empty scope for a scoped type like
    ``markdown``, so a project-scoped search would find nothing and the test
    would be asserting the fixture rather than the feature.
    """
    monkeypatch.chdir(tmp_path)
    return tmp_path


@pytest.fixture
def make_source(watched, project, in_workspace):
    """A saved folder DataSource in the requested reflect mode.

    Also creates the Project the assets belong to, mounted at the directory
    that mode actually indexes FROM — the watched tree for ``none``/``symlink``
    (the indexer resolves through a link, so the entity keys on the target) and
    the project tree for ``copy``. ``load_project_mounts`` allows temp paths
    explicitly, so no other setup is needed.
    """

    async def _make(mode: str = ReflectMode.NONE.value) -> tuple[DataSource, Project]:
        landing = project if mode == ReflectMode.COPY.value else watched
        proj = Project(name="matrix-project", fs_storage_mount_path=str(landing))
        await proj.save()

        src = DataSource(
            name="watched-folder",
            provider="folder",
            config={"root": str(watched)},
            reflect=mode,
            reflect_into=str(project) if mode in
            (ReflectMode.COPY.value, ReflectMode.SYMLINK.value) else "",
        )
        await src.save()
        return src, proj

    return _make
