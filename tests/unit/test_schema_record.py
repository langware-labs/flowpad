"""Unit tests for SchemaRecord — pure, no server needed."""

from __future__ import annotations

import json
from unittest import mock

from flow_sdk.fs_records.schema_record import (
    IndexRequest,
    IndexResult,
    ScanResult,
    SchemaRecord,
    _append_jsonl,
)

# ---------------------------------------------------------------------------
# Dataclass field tests
# ---------------------------------------------------------------------------


def test_scan_result_fields():
    sr = ScanResult(type_name="skill", count=3, total_bytes=1024, scan_ms=12.5)
    assert sr.type_name == "skill"
    assert sr.count == 3
    assert sr.total_bytes == 1024
    assert sr.scan_ms == 12.5
    assert sr.last_scan_at is None


def test_index_result_fields():
    ir = IndexResult(type_name="bookmark", indexed=5, skipped=1, duration_ms=88.0)
    assert ir.type_name == "bookmark"
    assert ir.indexed == 5
    assert ir.skipped == 1
    assert ir.duration_ms == 88.0
    assert ir.last_index_at is None


def test_index_request_defaults():
    req = IndexRequest()
    assert req.actions == ["scan", "index"]
    assert req.types is None
    assert req.start_time is None
    assert req.end_time is None
    assert req.trigger == "manual"
    assert req.limit_per_type is None


# ---------------------------------------------------------------------------
# append_scan / append_index + log file tests
# ---------------------------------------------------------------------------


def test_append_scan_writes_global_log(tmp_path):
    with mock.patch("flow_sdk.fs_store.schema_registry.SCHEMA_DIR", tmp_path):
        ts = SchemaRecord.append_scan(
            trigger="test",
            duration_ms=10.0,
            total_records=5,
            total_bytes=512,
            types=[],
        )
    global_log = tmp_path / "scan_log.jsonl"
    assert global_log.exists()
    entry = json.loads(global_log.read_text().strip().splitlines()[-1])
    assert entry["scan_trigger"] == "test"
    assert entry["total_records"] == 5
    assert entry["created_at"] == ts


def test_append_scan_writes_per_type_log(tmp_path):
    with mock.patch("flow_sdk.fs_store.schema_registry.SCHEMA_DIR", tmp_path):
        ts = SchemaRecord.append_scan(
            trigger="test",
            duration_ms=5.0,
            total_records=2,
            total_bytes=200,
            types=[],
            type_name="skill",
        )
    per_type_log = tmp_path / "types" / "skill" / "scan_log.jsonl"
    assert per_type_log.exists()
    entry = json.loads(per_type_log.read_text().strip().splitlines()[-1])
    assert entry["type_name"] == "skill"
    assert entry["created_at"] == ts


def test_append_index_writes_both_logs(tmp_path):
    with mock.patch("flow_sdk.fs_store.schema_registry.SCHEMA_DIR", tmp_path):
        ts = SchemaRecord.append_index(
            trigger="test",
            duration_ms=20.0,
            total_indexed=3,
            types=[{"type": "bookmark", "indexed": 3}],
        )
    assert (tmp_path / "index_log.jsonl").exists()
    assert (tmp_path / "types" / "bookmark" / "index_log.jsonl").exists()

    global_entry = json.loads((tmp_path / "index_log.jsonl").read_text().strip().splitlines()[-1])
    assert global_entry["total_indexed"] == 3
    assert global_entry["created_at"] == ts

    per_type_entry = json.loads(
        (tmp_path / "types" / "bookmark" / "index_log.jsonl").read_text().strip().splitlines()[-1]
    )
    assert per_type_entry["total_indexed"] == 3


def test_get_last_scan_at_none_when_missing(tmp_path):
    with mock.patch("flow_sdk.fs_store.schema_registry.SCHEMA_DIR", tmp_path):
        result = SchemaRecord.get_last_scan_at("nonexistent_type")
    assert result is None


def test_get_last_index_at_returns_timestamp(tmp_path):
    with mock.patch("flow_sdk.fs_store.schema_registry.SCHEMA_DIR", tmp_path):
        ts = SchemaRecord.append_index(
            trigger="t",
            duration_ms=1.0,
            total_indexed=1,
            types=[],
            type_name="skill",
        )
        result = SchemaRecord.get_last_index_at("skill")
    assert result == ts


def test_scan_type_include_records(tmp_path):
    """_scan_type with include_records=True populates the records list."""
    from unittest.mock import MagicMock, patch

    from flow_sdk.fs_records.schema_record import SchemaRecord

    # Build a fake record that has source_file pointing to a real file
    skill_file = tmp_path / "skill.md"
    skill_file.write_text("# skill content")
    file_size = skill_file.stat().st_size

    fake_rec = MagicMock()
    fake_rec.id = "test-uid-1"
    fake_rec.name = "test skill"
    fake_rec.source_file = str(skill_file)
    fake_rec.status = "active"
    fake_rec.modified_at = "2026-01-01T00:00:00Z"
    fake_rec.created_at = None

    from flow_sdk.fs_records.skill_record import SkillRecord

    with patch("flow_sdk.fs_store.record_list.RecordList") as mock_list_cls:
        mock_list_cls.return_value = iter([fake_rec])
        result = SchemaRecord._scan_type(SkillRecord, include_records=True)

    assert result.count == 1
    assert result.total_bytes == file_size
    assert result.avg_bytes == file_size
    assert result.min_bytes == file_size
    assert result.max_bytes == file_size
    assert result.records is not None
    assert len(result.records) == 1
    rec = result.records[0]
    assert rec["id"] == "test-uid-1"
    assert rec["name"] == "test skill"
    assert rec["size_bytes"] == file_size
    assert rec["status"] == "active"


def test_scan_type_exclude_records(tmp_path):
    """_scan_type with include_records=False (default) leaves records as None."""
    from unittest.mock import MagicMock, patch

    from flow_sdk.fs_records.schema_record import SchemaRecord
    from flow_sdk.fs_records.skill_record import SkillRecord

    skill_file = tmp_path / "skill.md"
    skill_file.write_text("# content")

    fake_rec = MagicMock()
    fake_rec.id = "test-uid-2"
    fake_rec.source_file = str(skill_file)
    fake_rec.status = None
    fake_rec.modified_at = None
    fake_rec.created_at = None

    with patch("flow_sdk.fs_store.record_list.RecordList") as mock_list_cls:
        mock_list_cls.return_value = iter([fake_rec])
        result = SchemaRecord._scan_type(SkillRecord)

    assert result.records is None
    assert result.count == 1
    assert result.min_bytes == 0
    assert result.max_bytes == 0


def test_trim_to_max_100_entries(tmp_path):
    log_path = tmp_path / "test_log.jsonl"
    # Write 110 entries
    for i in range(110):
        _append_jsonl(log_path, {"i": i})
    lines = log_path.read_text().strip().splitlines()
    assert len(lines) == 100
    # Verify we kept the last 100 (entries 10–109)
    first_kept = json.loads(lines[0])
    assert first_kept["i"] == 10
    last_kept = json.loads(lines[-1])
    assert last_kept["i"] == 109
