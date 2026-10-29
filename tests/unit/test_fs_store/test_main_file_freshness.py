"""An asset folder is fresh by its main file, not by the folder alone.

Editing a file does not touch its folder's mtime, so a type that was fresh by the folder's stat never
re-read an edited ``credential.json`` or ``data_driver.json``: the shipped credential templates kept
their old rows after a release changed them. Every type that declares a main file now hashes it too.
"""
from __future__ import annotations

import os

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — registers every TypeInfo
import flow_sdk.models.entities  # noqa: F401
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.schema_registry import SchemaRegistry


@pytest.mark.parametrize("type_name", ["credential", "data_driver", "mcp", "project_manifest"])
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
    # The token is the folder's mtime_ns (the diskio prober): two directory updates can land in the
    # SAME kernel clock tick on a fast machine (Linux file timestamps move per jiffy, not per ns —
    # first seen on Blacksmith runners). Pin the first state's stamp one tick back, so the change
    # below MUST move it: the mechanism under test is "a change moves the stat", not the tick width.
    st = folder.stat()
    os.utime(folder, ns=(st.st_atime_ns, st.st_mtime_ns - 1))
    token = info.asset_hash_fn(FSRef(folder))

    (folder / "source.py").write_text("")

    assert info.asset_hash_fn(FSRef(folder)) != token, "what the folder stat caught before, it still catches"
