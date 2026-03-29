"""Tests for Record.load() — polymorphic loading with data.json format."""

import json

import pytest

from flow_sdk.fs_store import Record
from flow_sdk.fs_store.record import _DATA_JSON


class TestPolymorphicLoad:
    def test_load_returns_task_resource(self, tmp_path):
        from flow_sdk.fs_records import TaskResource  # ensure auto-registration

        folder = tmp_path / "task-@t1"
        dj = folder / _DATA_JSON
        dj.parent.mkdir(parents=True)
        dj.write_text(json.dumps({"data": {"id": "t1", "type": "task", "title": "Test"}}))

        rec = Record.load(folder)
        assert isinstance(rec, TaskResource)
        assert rec.id == "t1"
        assert rec.title == "Test"

    def test_load_returns_skill_record(self, tmp_path):
        from flow_sdk.fs_records.skill_record import SkillRecord  # ensure auto-registration

        folder = tmp_path / "skill-@s1"
        dj = folder / _DATA_JSON
        dj.parent.mkdir(parents=True)
        dj.write_text(json.dumps({"data": {"id": "s1", "type": "skill", "name": "My Skill"}}))

        rec = Record.load(folder)
        assert isinstance(rec, SkillRecord)
        assert rec.name == "My Skill"

    def test_load_unknown_type_returns_record(self, tmp_path):
        folder = tmp_path / "custom-@c1"
        dj = folder / _DATA_JSON
        dj.parent.mkdir(parents=True)
        dj.write_text(json.dumps({"data": {"id": "c1", "type": "unknown_type"}}))

        rec = Record.load(folder)
        assert type(rec) is Record
        assert rec.id == "c1"

    def test_load_dir_finds_data_json(self, tmp_path):
        """load(dir) should find data.json inside the dir."""
        folder = tmp_path / "entity"
        dj = folder / _DATA_JSON
        dj.parent.mkdir(parents=True)
        dj.write_text(json.dumps({"data": {"id": "e1", "type": "test"}}))

        rec = Record.load(folder)
        assert rec.id == "e1"
        assert rec.source_file == str(dj)

    def test_load_nonexistent_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            Record.load(tmp_path / "nonexistent")

    def test_load_flat_json_format(self, tmp_path):
        """Record.load() also handles flat JSON (non-wrapped) for compatibility."""
        folder = tmp_path / "task-@flat"
        dj = folder / _DATA_JSON
        dj.parent.mkdir(parents=True)
        dj.write_text(json.dumps({"id": "flat", "type": "task", "title": "Flat"}))

        rec = Record.load(folder)
        assert rec.id == "flat"


class TestNewFormatIO:
    def test_init_record_reads_data_json(self, tmp_path):
        """init_record(dir) reads data.json from directory."""
        folder = tmp_path / "entity"
        folder.mkdir()
        (folder / _DATA_JSON).write_text(
            json.dumps({"data": {"id": "new1", "type": "test"}})
        )

        rec = Record.load_record(folder)
        assert rec.id == "new1"

    def test_init_record_data_writes_data_json(self, tmp_path):
        """init_record(data, path) writes metadata.json (+ _data.json) to folder."""
        folder = tmp_path / "entity"
        rec = Record._init_record({"id": "w1", "type": "test", "name": "new"}, folder)
        # New split format: id/type/name go to metadata.json
        data_path = folder / "metadata.json"
        assert data_path.exists()
        raw = json.loads(data_path.read_text())
        assert "data" in raw
        assert raw["data"]["id"] == "w1"

    def test_record_dir_from_data_json(self, tmp_path):
        """When loaded from data.json, record_dir is the parent folder."""
        folder = tmp_path / "entity"
        dj = folder / _DATA_JSON
        dj.parent.mkdir(parents=True)
        dj.write_text(json.dumps({"data": {"id": "rd1", "type": "test"}}))

        rec = Record.load_record(folder)
        assert rec.record_dir == folder
