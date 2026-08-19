"""A manifest on disk becomes an entity, through the real walker.

The point of making a data source a folder asset is that nothing new has to
discover it: `repo_assets_fn` already scans `agentic-assets/<family>/` in any
walked container. This drives that path rather than asserting it.
"""
from __future__ import annotations

import json
from pathlib import Path

import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — registers every type
import pytest
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
from flow_sdk.fs_store.record_types import RecordType

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

RSS = {
    "schema": 1,
    "name": "rss",
    "title": "RSS / Atom",
    "description": "One stream per feed URL. No credentials.",
    "icon_name": "Rss",
    "config": {"feed_urls": {"type": "lines", "required": True, "label": "Feed URLs"}},
}


def _seed(root: Path, name: str, manifest: dict) -> Path:
    folder = root / "agentic-assets" / "data_source" / name
    folder.mkdir(parents=True)
    (folder / "data_source.json").write_text(json.dumps(manifest), encoding="utf-8")
    return folder


async def _index(root: Path) -> None:
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope="user"))
    idx.add_function(RecordType.USER_HOME_FOLDER, repo_assets_fn)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.DATA_SOURCE_SPEC]))


async def test_a_manifest_folder_becomes_an_entity(folder_db, tmp_path):
    folder = _seed(tmp_path, "rss", RSS)

    await _index(tmp_path)

    ent = await Entity.get_by_asset_ref(str(folder))
    assert ent is not None, "the walker did not pick up the manifest"
    assert ent.type == "data_source_spec"
    assert (ent.name, ent.title, ent.runtime) == ("rss", "RSS / Atom", "builtin")
    assert ent.config_schema["feed_urls"]["required"] is True


async def test_a_rejected_manifest_yields_no_entity(folder_db, tmp_path):
    """A builtin declaring traits is a load error, so nothing is indexed."""
    folder = _seed(tmp_path, "bad", {**RSS, "name": "bad", "traits": {"channel": "x"}})

    await _index(tmp_path)

    assert await Entity.get_by_asset_ref(str(folder)) is None
