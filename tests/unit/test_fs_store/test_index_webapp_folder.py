"""`flow record index <path>` on a webapp folder, through the handler the CLI posts to.

Two gaps seen on a live instance with a project's ``agentic-assets/webapp/<app>``:

* named with no ``--types``, the folder answered ``total_indexed: 0`` — only ``?type=``
  routes a folder into the branch that indexes the folder itself; without it the
  subtree walk looks inside the folder and never at it;
* once the folder was deleted, re-indexing its project left the ``micro_app`` row in
  place — a re-index only counts orphans, so the app stayed in the header menu.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.indexer import reset_shared_indexer
from tests.unit.test_fs_store._index_handler_fakes import FakeRequestInfo, _Handler

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]


@pytest.fixture(autouse=True)
def _reset_indexer():
    reset_shared_indexer()
    yield
    reset_shared_indexer()


def _webapp(project: Path) -> Path:
    folder = project / "agentic-assets" / "webapp" / "probe-app"
    folder.mkdir(parents=True)
    (folder / "webapp.json").write_text('{"name": "probe-app"}', encoding="utf-8")
    (folder / "index.html").write_text("<h1>probe</h1>\n", encoding="utf-8")
    return folder


async def test_a_webapp_folder_indexes_without_naming_its_type(tmp_path: Path):
    folder = _webapp(tmp_path)

    resp = await _Handler()._handle_fs_records_index(FakeRequestInfo({"path": str(folder)}))

    row = await Entity.get_by_asset_ref(str(folder), resolve_containing=False)
    assert row is not None, f"the webapp folder was not indexed: {resp.data}"


async def test_reindexing_a_project_drops_the_row_of_a_deleted_webapp(tmp_path: Path):
    folder = _webapp(tmp_path)
    await _Handler()._handle_fs_records_index(FakeRequestInfo({"type": "micro_app", "path": str(folder)}))
    assert await Entity.get_by_asset_ref(str(folder), resolve_containing=False) is not None

    shutil.rmtree(folder)
    await _Handler()._handle_fs_records_index(FakeRequestInfo({"path": str(tmp_path)}))

    row = await Entity.get_by_asset_ref(str(folder), resolve_containing=False)
    assert row is None, f"the deleted webapp's {row.type} row survived the re-index"
