"""Tests for record folder storage.

Records with FOLDER layout store domain data files directly in the record folder.
"""

import json
from pathlib import Path
from typing import ClassVar

import pytest

from flow_sdk.fs_store.record import (
    Record,
    _META_JSON,
    get_default_records_root,
    set_default_records_root,
)


class SampleRecord(Record):
    _record_type: ClassVar[str] = "test_record"

    @property
    def content(self) -> str | None:
        return getattr(self, "description", None)


@pytest.fixture
def tmp_record(tmp_path):
    old_root = get_default_records_root()
    set_default_records_root(tmp_path)
    rec = SampleRecord(type="test_record", id="test-001", name="Test", description="Hello")
    rec.path = str(tmp_path / "test_record" / "test_record-@test-001")
    rec.save()
    yield rec, tmp_path
    set_default_records_root(old_root)


class TestDataSubfolder:
    def test_save_creates_metadata_json(self, tmp_record):
        """save() creates metadata.json in the record folder."""
        rec, tmp_path = tmp_record
        rd = Path(rec.path)
        meta_file = rd / _META_JSON
        assert meta_file.exists()

    def test_save_writes_all_fields_to_metadata(self, tmp_record):
        """save() writes all fields into metadata.json."""
        rec, tmp_path = tmp_record
        rd = Path(rec.path)
        meta_file = rd / _META_JSON
        assert meta_file.exists()
        raw = json.loads(meta_file.read_text())
        data = raw.get("data", raw)
        assert data.get("description") == "Hello"
        # No separate _obj_data.json should exist
        legacy_domain = rd / "_obj_data.json"
        assert not legacy_domain.exists()

    def test_load_reads_from_metadata_json(self, tmp_record):
        """Loading a record reads from metadata.json."""
        rec, tmp_path = tmp_record
        # Create a fresh record and load from disk
        rec2 = SampleRecord(type="test_record", id="test-001")
        rec2.path = rec.path
        rec2.source_file = str(Path(rec.path) / _META_JSON)
        rec2._load_split_format(Path(rec.path))
        assert getattr(rec2, "description", None) == "Hello"

    def test_load_migrates_from_root_level(self, tmp_path):
        """Loading falls back to root-level _obj_data.json for legacy records."""
        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            folder = tmp_path / "test_record" / "test_record-@legacy-001"
            folder.mkdir(parents=True, exist_ok=True)
            # Write metadata.json at root
            meta = {"data": {"id": "legacy-001", "type": "test_record", "name": "Legacy"}}
            (folder / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
            # Write _obj_data.json at ROOT (legacy location)
            domain = {"data": {"description": "Legacy data"}}
            (folder / "_obj_data.json").write_text(json.dumps(domain), encoding="utf-8")

            rec = SampleRecord(type="test_record", id="legacy-001")
            rec.path = str(folder)
            rec.source_file = str(folder / "metadata.json")
            rec._load_split_format(folder)
            assert getattr(rec, "description", None) == "Legacy data"
        finally:
            set_default_records_root(old_root)

    def test_write_file_goes_to_record_folder(self, tmp_record):
        """write_file() puts files directly in the record folder."""
        rec, _ = tmp_record
        p = rec.write_file("notes.txt", "some notes")
        rd = Path(rec.path)
        assert p.parent == rd
        assert p.read_text() == "some notes"

    def test_read_file_reads_from_record_folder(self, tmp_path):
        """read_file() reads files from the record folder."""
        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            folder = tmp_path / "test_record" / "test_record-@fb-001"
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "notes.txt").write_text("some notes", encoding="utf-8")

            rec = SampleRecord(type="test_record", id="fb-001")
            rec.path = str(folder)
            assert rec.read_file("notes.txt") == "some notes"
        finally:
            set_default_records_root(old_root)

    def test_output_dir_under_record_folder(self, tmp_record):
        """output_dir is under the record folder."""
        rec, _ = tmp_record
        rd = Path(rec.path)
        assert rec.output_dir == rd / "output"
        assert rec.output_dir.is_dir()

    def test_input_dir_under_record_folder(self, tmp_record):
        """input_dir is under the record folder."""
        rec, _ = tmp_record
        rd = Path(rec.path)
        assert rec.input_dir == rd / "input"
        assert rec.input_dir.is_dir()

