"""Tests for CollectionManifest O(1) change detection."""

from __future__ import annotations

import threading

import pytest

from flow_sdk.fs_store.manifest import CollectionManifest
from flow_sdk.fs_store.record import get_default_records_root, set_default_records_root


@pytest.fixture()
def tmp_records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


@pytest.fixture()
def manifest(tmp_records_root):
    return CollectionManifest("skill", records_root=tmp_records_root)


def test_bump_add_increments_version_and_count(manifest):
    manifest.bump("add")
    manifest.bump("add")
    data = manifest.read()
    assert data is not None
    assert data["version"] == 2
    assert data["count"] == 2


def test_bump_remove_decrements_count(manifest):
    manifest.bump("add")
    manifest.bump("remove")
    data = manifest.read()
    assert data is not None
    assert data["count"] == 0
    assert data["version"] == 2


def test_bump_remove_floors_at_zero(manifest):
    manifest.bump("remove")
    data = manifest.read()
    assert data is not None
    assert data["count"] == 0
    assert data["version"] == 1


def test_needs_refresh_true(manifest):
    manifest.bump("add")
    assert manifest.needs_refresh(0) is True


def test_needs_refresh_false(manifest):
    manifest.bump("add")
    assert manifest.needs_refresh(1) is False


def test_read_missing_returns_none(manifest):
    assert manifest.read() is None


def test_rebuild_writes_both_files(manifest):
    manifest.rebuild(["id-1", "id-2", "id-3"])
    assert manifest._path.exists()
    assert manifest._ids_path.exists()
    data = manifest.read()
    assert data is not None
    assert data["count"] == 3
    assert data["version"] == 1

    import json
    ids_data = json.loads(manifest._ids_path.read_text(encoding="utf-8"))
    assert ids_data["record_ids"] == ["id-1", "id-2", "id-3"]


def test_concurrent_bump(manifest):
    """Two threads bump simultaneously, final version = 2 (no lost updates)."""
    barrier = threading.Barrier(2)

    def bump_with_barrier():
        barrier.wait()
        manifest.bump("add")

    t1 = threading.Thread(target=bump_with_barrier)
    t2 = threading.Thread(target=bump_with_barrier)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    data = manifest.read()
    assert data is not None
    assert data["version"] == 2
    assert data["count"] == 2
