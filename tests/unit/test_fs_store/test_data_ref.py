"""Tests for RecordRef.content_hash and data_ref on Record."""

from pathlib import Path
from typing import ClassVar

import pytest

from flow_sdk.fs_store import Record, RecordList
from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root
from flow_sdk.fs_store.record_ref import RecordRef


class RefRecord(Record):
    """Referenced record type for tests."""
    _record_type: ClassVar[str] = "ref_test"

    def __init__(self, **kwargs):
        kwargs.setdefault("type", "ref_test")
        super().__init__(**kwargs)


@pytest.fixture(autouse=True)
def _use_tmp_records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield
    set_default_records_root(original)


class TestContentHash:
    def test_deterministic(self):
        ref = RecordRef(path="/home/user/.claude/settings.json", json_path="/permissions")
        h1 = ref.content_hash
        h2 = ref.content_hash
        assert h1 == h2
        assert len(h1) == 12

    def test_different_paths_different_hash(self):
        r1 = RecordRef(path="/a/b.json")
        r2 = RecordRef(path="/c/d.json")
        assert r1.content_hash != r2.content_hash

    def test_same_path_same_hash(self):
        r1 = RecordRef(path="/a/b.json", json_path="/x")
        r2 = RecordRef(path="/a/b.json", json_path="/x")
        assert r1.content_hash == r2.content_hash

    def test_json_path_matters(self):
        r1 = RecordRef(path="/a/b.json", json_path="/x")
        r2 = RecordRef(path="/a/b.json", json_path="/y")
        assert r1.content_hash != r2.content_hash

    def test_empty_ref(self):
        ref = RecordRef()
        h = ref.content_hash
        assert isinstance(h, str)
        assert len(h) == 12


class TestDataRef:
    def test_data_ref_removed(self):
        """data_ref property has been removed from Record. Use asset_ref (FSRef) instead."""
        rec = RefRecord(id="dr-1")
        # data_ref no longer exists as a property — accessing it stores/reads from _data directly
        assert not hasattr(type(rec), "data_ref") or "data_ref" not in type(rec).__dict__

    def test_asset_ref_defaults_to_none(self):
        rec = RefRecord(id="dr-2")
        assert rec.asset_ref is None
