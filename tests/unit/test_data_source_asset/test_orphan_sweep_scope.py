"""A project's orphan sweep reaps only that project's records whose source is gone.

The shipped system project is indexed at boot, but a project-scoped sweep walks
the user's project roots and not the system root. One such sweep took all 20
shipped data drivers off a running instance: an unwalked record was counted as
an orphan although its folder was right where it was, and the ``system`` scope
fell through the scope filter as if it were unscoped. Driven through the real
walker and the real DELETE sweep, as the index route runs them.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — registers every type
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions, OrphanAction
from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.server.search_filters import ScopeFilter

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

SYSTEM_PID = "c7a0cc9f-0f16-4ae6-b389-ab9fd78dfe9d"
PROJECT_PID = "c82a1115-2f20-52e0-aa2a-4658898b5873"


def _driver(root: Path, name: str) -> Path:
    folder = root / "agentic-assets" / "data_driver" / name
    folder.mkdir(parents=True)
    manifest = {"schema": 1, "name": name, "title": name, "description": "", "config": {}}
    (folder / "data_driver.json").write_text(json.dumps(manifest), encoding="utf-8")
    return folder


def _indexer(*roots: FSRef) -> FSIndexer:
    idx = FSIndexer()
    for root in roots:
        idx.add_root(root)
    idx.add_function(RecordType.USER_HOME_FOLDER, repo_assets_fn)
    return idx


@pytest.fixture
async def world(folder_db, tmp_path):
    """Boot indexes the system project and a user project; the sweep walks only the latter."""
    system_root = FSRef(tmp_path / "system", record_type=RecordType.USER_HOME_FOLDER, scope="system", project_id=SYSTEM_PID)
    project_root = FSRef(tmp_path / "project", record_type=RecordType.USER_HOME_FOLDER, scope="project", project_id=PROJECT_PID)
    shipped = _driver(tmp_path / "system", "shipped")
    authored = _driver(tmp_path / "project", "authored")
    await _indexer(system_root, project_root).index(IndexerOptions(verbose=False, types=[RecordType.DATA_DRIVER]))
    assert await Entity.get_by_asset_ref(str(shipped)) is not None
    assert await Entity.get_by_asset_ref(str(authored)) is not None
    return shipped, authored, _indexer(project_root)


async def _sweep(sweep: FSIndexer, *projects: str):
    return await sweep.index(
        IndexerOptions(
            verbose=False,
            types=[RecordType.DATA_DRIVER],
            scope_filter=ScopeFilter(user=False, projects=projects),
            orphan_action=OrphanAction.DELETE,
        )
    )


async def test_a_record_the_sweep_did_not_walk_is_not_an_orphan(world):
    """Unseen is not gone: with the system project selected, its driver survives a sweep
    that never walked the system root, while the project's deleted driver is reaped."""
    shipped, authored, sweep = world
    (authored / "data_driver.json").unlink()
    authored.rmdir()

    await _sweep(sweep, PROJECT_PID, SYSTEM_PID)

    assert await Entity.get_by_asset_ref(str(shipped)) is not None, "its folder exists — not an orphan"
    assert await Entity.get_by_asset_ref(str(authored)) is None, "the project's own deleted driver is reaped"


async def test_a_project_sweep_leaves_the_system_project_alone(world):
    """``system`` is project-like: its rows match only when the system project is selected,
    so another project's sweep never reaps them — even one whose folder is gone."""
    shipped, _authored, sweep = world
    (shipped / "data_driver.json").unlink()
    shipped.rmdir()

    await _sweep(sweep, PROJECT_PID)

    assert await Entity.get_by_asset_ref(str(shipped)) is not None, "outside the swept project"
