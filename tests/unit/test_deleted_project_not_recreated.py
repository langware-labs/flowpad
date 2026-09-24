"""A deleted project's folder must never be recreated on disk.

Proven on a live instance: a scoped read cached the project in
``get_cached_projects``; the project was deleted and its root removed; the next
desktop-db clear re-ran bootstrap, whose namespace seeding iterated the STALE
cached list and ``ensure_namespace``'s atomic write recreated
``<root>/agentic-assets/project_manifest/project_manifest.json``.

Two independent guards, one test each: seeding never creates a folder, and a
project delete drops the cached list.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.builtin.project_manifest import ensure_project_namespace
from flow_sdk.fs_store import path_utils
from flow_sdk.fs_store.operations.all_projects import get_cached_projects, invalidate_projects_cache

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture
def tmp_mounts_allowed(monkeypatch: pytest.MonkeyPatch) -> None:
    """tmp_path is a temp dir, which the cwd policy gate rejects before seeding is
    reached. Admit temp paths so the test exercises the seeding itself, as a real
    (non-temp) project root would."""
    real = path_utils.is_valid_project_cwd
    monkeypatch.setattr(path_utils, "is_valid_project_cwd", lambda p, **kw: real(p, include_temp=True))


def _manifest(root: Path) -> Path:
    return root / "agentic-assets" / "project_manifest" / "project_manifest.json"


async def test_seeding_names_an_existing_project_root(tmp_path: Path, tmp_mounts_allowed) -> None:
    """Control: with the root present, seeding does write the manifest — so the
    missing-root case below is not passing vacuously on an earlier gate."""
    root = tmp_path / "live-proj"
    root.mkdir()

    ensure_project_namespace(Project(name="live-proj", fs_storage_mount_path=str(root)))

    assert _manifest(root).exists()


async def test_seeding_never_recreates_a_removed_project_root(tmp_path: Path, tmp_mounts_allowed) -> None:
    root = tmp_path / "deleted-proj"

    ensure_project_namespace(Project(name="deleted-proj", fs_storage_mount_path=str(root)))

    assert not root.exists(), f"namespace seeding recreated a removed project root: {sorted(root.rglob('*'))}"


@pytest.mark.parametrize("how", ["instance", "by_id"])
async def test_deleting_a_project_drops_it_from_the_cached_list(tmp_path: Path, how: str) -> None:
    root = tmp_path / f"cached-proj-{how}"
    root.mkdir()
    proj = Project(name=root.name, fs_storage_mount_path=str(root))
    await proj.save()
    invalidate_projects_cache()
    assert proj.id in {p.id for p in await get_cached_projects(force=True)}

    if how == "instance":
        await proj.delete()
    else:
        await Project.delete_by_id(str(proj.id))

    assert proj.id not in {p.id for p in await get_cached_projects()}, "deleted project still served from the cache"
