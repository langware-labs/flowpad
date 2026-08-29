"""``DataSource.origin`` — WHERE a source's bytes come from, as a typed origin
the driver stamps; reflection reads it, and a non-local origin materializes
through the ``FSOriginDriver`` registry."""
from __future__ import annotations

import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import flow_sdk.ingest.drivers  # noqa: F401 — register every driver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.fs_store.origin.git_origin import GitOrigin
from flow_sdk.fs_store.origin.local_origin import LocalOrigin, local_origin_for_path
from flow_sdk.ingest import reflect
from flow_sdk.ingest.driver import get_driver
from tests.unit.test_git_source.conftest import git_db  # noqa: F401 — an isolated driver

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def test_each_tree_driver_derives_a_local_origin(tmp_path):
    root = tmp_path / "watched"
    root.mkdir()
    expected = local_origin_for_path(root.resolve())   # THE one LocalOrigin shape
    folder = get_driver("folder").origin_for(SimpleNamespace(config={"root": str(root)}))
    assert isinstance(folder, LocalOrigin) and folder == expected
    git = get_driver("git").origin_for(SimpleNamespace(config={"repo": str(root)}))
    assert git == expected
    assert get_driver("git").origin_for(SimpleNamespace(config={})) is None
    cache = tmp_path / "cache"
    gdrive = get_driver("gdrive").origin_for(SimpleNamespace(config={"cache_root": str(cache)}, id="s"))
    assert gdrive == local_origin_for_path(cache.resolve())


async def test_local_root_reads_the_origin_not_a_config_key(tmp_path):
    src = SimpleNamespace(id="s", origin=local_origin_for_path(tmp_path), config={"root": "/elsewhere"})
    assert await reflect._materialize(src) == tmp_path
    assert await reflect._materialize(SimpleNamespace(id="s", origin=None)) is None


@pytest.mark.asyncio
async def test_save_stamps_the_origin_from_config(git_db, tmp_path):  # noqa: F811
    root = tmp_path / "w"
    root.mkdir()
    src = DataSource(name="w", provider="folder", config={"root": str(root)})
    await src.save()
    assert src.origin == local_origin_for_path(root.resolve())
    moved = tmp_path / "w2"
    moved.mkdir()
    src.config = {"root": str(moved)}
    await src.save()
    assert src.origin == local_origin_for_path(moved.resolve()), "origin follows config on every save"


@pytest.mark.asyncio
async def test_a_non_local_origin_materializes_through_the_origin_driver(tmp_path, monkeypatch):
    landed = tmp_path / "clone"
    (landed / "docs").mkdir(parents=True)
    seen = {}

    class _Driver:
        async def materialize(self, origin, *, preferred_root=None, preferred_project_id=None):
            seen["preferred_root"] = preferred_root
            return landed, None

    monkeypatch.setattr("flow_sdk.builtin.fs_origin_driver.get_origin_driver", lambda kind: _Driver())
    origin = GitOrigin(provider="github", owner="o", name="n", rel_path="docs")
    src = SimpleNamespace(id="s1", provider="git", origin=origin, reflect_into=str(tmp_path / "into"))
    assert await reflect._materialize(src) == landed / "docs"
    assert seen["preferred_root"] == tmp_path / "into", "reflect_into is the clone target"
    # The page threads that root into placement and identity — no module state.
    assert reflect.default_origin_id(src, str(landed / "docs" / "a.md"), landed / "docs").endswith(":path:a.md")


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


@pytest.mark.asyncio
async def test_a_nonexistent_preferred_root_is_the_clone_target(tmp_path):
    """The one change under ``GitOriginDriver.materialize``: a caller naming a
    root that does not exist yet is naming where the clone lands."""
    from flow_sdk.builtin.drivers.git_driver import GitOriginDriver

    origin_repo = tmp_path / "origin"
    origin_repo.mkdir()
    _git(origin_repo, "init", "-q", "-b", "main")
    _git(origin_repo, "config", "user.email", "t@example.com")
    _git(origin_repo, "config", "user.name", "T")
    (origin_repo / "a.md").write_text("a\n")
    _git(origin_repo, "add", ".")
    _git(origin_repo, "commit", "-q", "-m", "seed")
    git_origin = GitOrigin.from_url(origin_repo.resolve().as_uri(), branch="main", rel_path=".")
    assert git_origin is not None
    cache = tmp_path / "cache" / "asset"
    root, _ = await GitOriginDriver().materialize(git_origin, preferred_root=cache, preferred_project_id=None)
    assert root.resolve() == cache.resolve() and (cache / ".git").exists()
