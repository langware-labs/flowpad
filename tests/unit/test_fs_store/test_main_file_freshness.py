"""An asset folder is fresh by its main file, not by the folder alone.

Editing a file does not touch its folder's mtime, so a type that was fresh by the folder's stat never
re-read an edited ``secret_pack.json`` or ``data_driver.json``: the shipped credential templates kept
their old rows after a release changed them. Every type that declares a main file now hashes it too.
"""
from __future__ import annotations

import os

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — registers every TypeInfo
import flow_sdk.models.entities  # noqa: F401
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.schema_registry import SchemaRegistry


@pytest.mark.parametrize("type_name", ["secret_pack", "data_driver", "mcp", "project_manifest"])
def test_editing_the_main_file_changes_the_freshness_token(tmp_path, type_name):
    info = SchemaRegistry.get(type_name)
    folder = tmp_path / "asset"
    folder.mkdir()
    main = folder / info.shape.main
    main.write_text('{"name": "asset"}')
    before_folder = folder.stat()
    token = info.asset_hash_fn(FSRef(folder))

    main.write_text('{"name": "asset", "setup": "new instructions"}')
    os.utime(folder, ns=(before_folder.st_atime_ns, before_folder.st_mtime_ns))  # the folder looks untouched

    assert info.asset_hash_fn(FSRef(folder)) != token


def test_adding_a_file_beside_it_still_counts(tmp_path):
    info = SchemaRegistry.get("data_driver")
    folder = tmp_path / "driver"
    folder.mkdir()
    (folder / info.shape.main).write_text("{}")
    token = info.asset_hash_fn(FSRef(folder))

    (folder / "source.py").write_text("")

    assert info.asset_hash_fn(FSRef(folder)) != token, "what the folder stat caught before, it still catches"
