"""Shared setup for the git-source matrix.

Two repositories, deliberately. The receiving project and the asset repository
are not necessarily the same git, and `copy` (vendoring into the receiving
repo) depends on that being genuinely true rather than simulated with two
directories in one repo.
"""
import subprocess
from pathlib import Path

import pytest
import pytest_asyncio

import flow_sdk.db.drivers.db_driver as db_driver_mod
import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — side-effect: register_all()
import flow_sdk.ingest.drivers  # noqa: F401 — side-effect: register every driver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.project import Project
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver
from flow_sdk.ingest.reflect import ReflectMode


def git(path: Path, *args: str) -> str:
    """Run git in ``path``; raise on failure. Mirrors ``tests/unit/conftest.py``."""
    return subprocess.run(
        ["git", *args], cwd=path, capture_output=True, text=True, check=True
    ).stdout.strip()


def commit(repo: Path, message: str) -> str:
    """Stage everything and commit. Returns the new sha.

    ``add -A`` so deletions and renames are staged too — a matrix that only
    added files would never exercise the diff statuses the driver exists to
    read.
    """
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def init_repo(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.name", "Test User")
    git(path, "config", "user.email", "test@example.com")
    # A repo with no commits has no HEAD to diff against, and every CRUD case
    # needs a "before" state that is not the empty tree.
    (path / "README.md").write_text("seed\n", encoding="utf-8")
    git(path, "add", "."); git(path, "commit", "-q", "-m", "seed")
    return path


@pytest_asyncio.fixture
async def git_db(tmp_path):
    """Isolated driver bound to ``Entity`` — same swap/restore as fs_store."""
    cfg = DBConfig()
    cfg.database = str(tmp_path / "git_source.db")
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
def asset_repo(tmp_path):
    """The repository content is committed to — the source."""
    origin = init_repo(tmp_path / "origin")
    # A real remote, so `GitOrigin.from_url` has something to parse and the
    # origin key is the documented cross-machine handle rather than a fallback.
    repo = tmp_path / "asset"
    # Clone from the URI, not the bare path: `parse_git_origin_url` accepts
    # `file://` and rejects a plain path, and a repo whose remote does not parse
    # falls back to the generic path handle — the tests would still pass while
    # quietly not exercising `GitOrigin.key()` at all.
    git(tmp_path, "clone", "-q", origin.as_uri(), str(repo))
    git(repo, "config", "user.name", "Test User")
    git(repo, "config", "user.email", "test@example.com")
    return repo


@pytest.fixture
def receiving(tmp_path):
    """The project's own repository — a DIFFERENT git."""
    return init_repo(tmp_path / "receiving")


@pytest.fixture
def make_source(asset_repo, receiving, tmp_path, monkeypatch):
    """A saved git DataSource in the requested delivery mode, plus its Project.

    cwd is the workspace so `Entity._scope_from_path` infers `scope="project"`;
    without it every asset lands `scope=""`, which `apply_scope_filter` DROPS
    for a scoped type — the project assertions would then be testing the
    fixture rather than the feature.
    """
    monkeypatch.chdir(tmp_path)

    async def _make(mode: str = ReflectMode.NONE.value):
        if mode == ReflectMode.NONE.value:
            landing, into = asset_repo, ""
        else:  # copy — vendored into the receiving repo's tracked tree
            landing, into = receiving, str(receiving)

        proj = Project(name="git-project", fs_storage_mount_path=str(landing))
        await proj.save()

        src = DataSource(
            name="asset-repo",
            provider="git",
            config={"repo": str(asset_repo), "branch": "main"},
            reflect=mode,
            reflect_into=into,
        )
        await src.save()
        return src, proj, landing

    return _make
