"""Tests for scan-discover-compat: discover(), discover_one(), init_record().

Verifies that these methods read data.json (new format), call
_migrate_old_format() for backward compat, and derive id/type from
directory name.
"""

import json
from pathlib import Path
from typing import ClassVar

import pytest

from flow_sdk.fs_store.record import (
    Record,
    _DATA_JSON,
    _META_JSON,
    _NAME_SEP,
    record_stem,
    set_default_records_root,
)


class SampleRecord(Record):
    """Typed record for discover tests."""
    _record_type: ClassVar[str] = "sample"

    def __init__(self, **kwargs):
        kwargs.setdefault("type", "sample")
        super().__init__(**kwargs)


def _write_data_json(folder: Path, data: dict) -> Path:
    """Write a data.json file in wrapped format."""
    folder.mkdir(parents=True, exist_ok=True)
    dj = folder / _DATA_JSON
    dj.write_text(json.dumps({"data": data}), encoding="utf-8")
    return dj


def _write_old_format(folder: Path, data: dict) -> Path:
    """Write an old-format .flow_record/record.json file."""
    old_dir = folder / ".flow_record"
    old_dir.mkdir(parents=True, exist_ok=True)
    old_file = old_dir / "record.json"
    old_file.write_text(json.dumps(data), encoding="utf-8")
    return old_file


@pytest.fixture(autouse=True)
def records_root(tmp_path):
    """Set the default records root to tmp_path for all tests."""
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(Path.home() / ".flow" / "records")


class TestDiscoverReadsDataJson:
    def test_discover_reads_data_json(self, records_root):
        """discover() finds records with data.json format."""
        type_dir = records_root / "sample"
        folder = type_dir / record_stem("sample", "abc123")
        _write_data_json(folder, {"id": "abc123", "type": "sample", "name": "Hello"})

        results = SampleRecord.discover()
        assert len(results) == 1
        assert results[0].id == "abc123"
        assert results[0].type == "sample"
        assert results[0].name == "Hello"

    def test_discover_multiple_records(self, records_root):
        """discover() returns all records of the type."""
        type_dir = records_root / "sample"
        for uid in ("r1", "r2", "r3"):
            folder = type_dir / record_stem("sample", uid)
            _write_data_json(folder, {"id": uid, "type": "sample", "name": f"rec-{uid}"})

        results = SampleRecord.discover()
        assert len(results) == 3
        uids = {r.id for r in results}
        assert uids == {"r1", "r2", "r3"}


class TestDiscoverMigratesOldFormat:
    def test_discover_migrates_old_format(self, records_root):
        """discover() on directory with .flow_record/record.json auto-migrates."""
        type_dir = records_root / "sample"
        folder = type_dir / record_stem("sample", "old1")
        _write_old_format(folder, {
            "id": "old1", "type": "sample", "name": "OldRecord",
            "created_at": "2025-01-01", "modified_at": "2025-06-01",
        })

        results = SampleRecord.discover()
        assert len(results) == 1
        assert results[0].id == "old1"
        assert results[0].name == "OldRecord"
        # Old format should be migrated to new split format
        assert (folder / _META_JSON).exists()
        assert not (folder / ".flow_record").exists()

    def test_discover_skips_dirs_without_data(self, records_root):
        """discover() skips directories that have neither data.json nor old format."""
        type_dir = records_root / "sample"
        folder = type_dir / record_stem("sample", "empty1")
        folder.mkdir(parents=True)
        # No data.json, no .flow_record/record.json

        results = SampleRecord.discover()
        assert len(results) == 0


class TestDiscoverOneReadsDataJson:
    def test_discover_one_reads_data_json(self, records_root):
        """discover_one(uid) returns record with correct _data."""
        type_dir = records_root / "sample"
        folder = type_dir / record_stem("sample", "found")
        _write_data_json(folder, {"id": "found", "type": "sample", "name": "FoundIt"})

        rec = SampleRecord.discover_one("found")
        assert rec is not None
        assert rec.id == "found"
        assert rec.name == "FoundIt"

    def test_discover_one_migrates_old_format(self, records_root):
        """discover_one() auto-migrates old format."""
        type_dir = records_root / "sample"
        folder = type_dir / record_stem("sample", "old2")
        _write_old_format(folder, {"id": "old2", "type": "sample", "name": "OldOne"})

        rec = SampleRecord.discover_one("old2")
        assert rec is not None
        assert rec.id == "old2"
        assert rec.name == "OldOne"
        # Migrated to new split format
        assert (folder / _META_JSON).exists()
        assert not (folder / ".flow_record").exists()

    def test_discover_one_missing_returns_none(self, records_root):
        """discover_one() returns None for non-existent uid."""
        rec = SampleRecord.discover_one("nonexistent")
        assert rec is None


class TestDiscoverEmptyDir:
    def test_discover_empty_dir_no_crash(self, records_root):
        """Directory with no data file returns empty list."""
        type_dir = records_root / "sample"
        type_dir.mkdir(parents=True)
        # Empty type directory

        results = SampleRecord.discover()
        assert results == []

    def test_discover_one_empty_folder_returns_none(self, records_root):
        """discover_one on folder with no data returns None."""
        type_dir = records_root / "sample"
        folder = type_dir / record_stem("sample", "ghost")
        folder.mkdir(parents=True)

        rec = SampleRecord.discover_one("ghost")
        assert rec is None


class TestInitRecordWritesDataJson:
    def test_init_record_writes_data_json(self, records_root):
        """init_record(data, path) writes data.json to folder root."""
        folder = records_root / "sample" / record_stem("sample", "new1")
        rec = SampleRecord._init_record(
            {"id": "new1", "type": "sample", "name": "NewRecord"},
            path=folder,
        )

        # New split format: metadata.json holds id/type/name
        mj = folder / _META_JSON
        assert mj.exists()
        raw = json.loads(mj.read_text())
        assert "data" in raw
        assert raw["data"]["id"] == "new1"
        assert raw["data"]["name"] == "NewRecord"
        # No .flow_record directory
        assert not (folder / ".flow_record").exists()

    def test_init_record_path_only_reads_data_json(self, records_root):
        """init_record(path) reads existing data.json."""
        folder = records_root / "sample" / record_stem("sample", "read1")
        _write_data_json(folder, {"id": "read1", "type": "sample", "name": "ReadMe"})

        rec = SampleRecord.load_record(folder)
        assert rec.id == "read1"
        assert rec.name == "ReadMe"

    def test_init_record_path_only_migrates_old_format(self, records_root):
        """init_record(path) migrates old format when data.json is missing."""
        folder = records_root / "sample" / record_stem("sample", "old3")
        _write_old_format(folder, {"id": "old3", "type": "sample", "name": "OldInit"})

        rec = SampleRecord.load_record(folder)
        assert rec.id == "old3"
        assert rec.name == "OldInit"
        # Migrated to new split format
        assert (folder / _META_JSON).exists()
        assert not (folder / ".flow_record").exists()
