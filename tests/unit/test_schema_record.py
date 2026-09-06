"""Unit tests for the index-run log — pure, no server needed."""

from __future__ import annotations

import json
from unittest import mock

from flow_sdk.fs_store.indexer import index_log
from flow_sdk.fs_store.indexer.index_log import _append_jsonl

# ---------------------------------------------------------------------------
# append_scan / append_index + log file tests
# ---------------------------------------------------------------------------


def test_append_scan_writes_global_log(tmp_path):
    with mock.patch("flow_sdk.fs_store.indexer.index_log._schema_dir", lambda: tmp_path):
        ts = index_log.append_scan(
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
    with mock.patch("flow_sdk.fs_store.indexer.index_log._schema_dir", lambda: tmp_path):
        ts = index_log.append_scan(
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
    """append_index now writes per-type only — global timestamp is derived
    in get_index_status as max(per_type[i].last_indexed_at) (see
    index_log.append_index docstring)."""
    with mock.patch("flow_sdk.fs_store.indexer.index_log._schema_dir", lambda: tmp_path):
        ts = index_log.append_index(
            trigger="test",
            duration_ms=20.0,
            total_indexed=3,
            types=[{"type": "bookmark", "indexed": 3}],
        )
    assert (tmp_path / "types" / "bookmark" / "index_log.jsonl").exists()

    per_type_entry = json.loads(
        (tmp_path / "types" / "bookmark" / "index_log.jsonl").read_text().strip().splitlines()[-1]
    )
    assert per_type_entry["total_indexed"] == 3
    assert per_type_entry["created_at"] == ts


def test_get_last_scan_at_none_when_missing(tmp_path):
    with mock.patch("flow_sdk.fs_store.indexer.index_log._schema_dir", lambda: tmp_path):
        result = index_log.get_last_scan_at("nonexistent_type")
    assert result is None


def test_get_last_index_at_returns_timestamp(tmp_path):
    with mock.patch("flow_sdk.fs_store.indexer.index_log._schema_dir", lambda: tmp_path):
        ts = index_log.append_index(
            trigger="t",
            duration_ms=1.0,
            total_indexed=1,
            types=[],
            type_name="skill",
        )
        result = index_log.get_last_index_at("skill")
    assert result == ts


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
