"""Tests for SchemaRegistry — TypeInfo, registration, persistence, logging."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from flow_sdk.fs_store.schema_registry import (
    SchemaRegistry,
    TypeInfo,
    _append_jsonl,
    _read_last_entry,
    _sanitize_type_name,
)
from flow_sdk.fs_store.type_id import TypeId

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fresh_registry():
    """Reset SchemaRegistry class-level state for test isolation."""
    SchemaRegistry._types.clear()
    SchemaRegistry._subtypes.clear()
    SchemaRegistry._default_index_types.clear()
    SchemaRegistry._persisted_hashes.clear()


@pytest.fixture(autouse=True)
def restore_registry():
    """Auto-use fixture: save registry state before each test, restore after.

    This ensures that real Entity subclass registrations (Shell, User, etc.)
    are not permanently wiped out when tests call _fresh_registry().
    """
    saved_types = dict(SchemaRegistry._types)
    saved_subtypes = {k: list(v) for k, v in SchemaRegistry._subtypes.items()}
    saved_default_index = list(SchemaRegistry._default_index_types)
    saved_hashes = dict(SchemaRegistry._persisted_hashes)
    yield
    SchemaRegistry._types.clear()
    SchemaRegistry._types.update(saved_types)
    SchemaRegistry._subtypes.clear()
    SchemaRegistry._subtypes.update({k: list(v) for k, v in saved_subtypes.items()})
    SchemaRegistry._default_index_types.clear()
    SchemaRegistry._default_index_types.extend(saved_default_index)
    SchemaRegistry._persisted_hashes.clear()
    SchemaRegistry._persisted_hashes.update(saved_hashes)


# ---------------------------------------------------------------------------
# _sanitize_type_name
# ---------------------------------------------------------------------------


def test_sanitize_type_name_replaces_colon():
    assert _sanitize_type_name("foo:bar") == "foo__bar"


def test_sanitize_type_name_replaces_space():
    assert _sanitize_type_name("foo bar") == "foo_bar"


def test_sanitize_type_name_no_change():
    assert _sanitize_type_name("simple") == "simple"


# ---------------------------------------------------------------------------
# TypeInfo
# ---------------------------------------------------------------------------


def test_type_info_schema_hash_is_stable():
    info = TypeInfo(type_name="skill", index_fields=["description"])
    h1 = info.schema_hash
    h2 = info.schema_hash
    assert h1 == h2
    assert len(h1) == 16


def test_type_info_schema_hash_changes_on_field_change():
    info1 = TypeInfo(type_name="skill", index_fields=["description"])
    info2 = TypeInfo(type_name="skill", index_fields=["title"])
    assert info1.schema_hash != info2.schema_hash


def test_type_info_to_dict_round_trip():
    info = TypeInfo(
        type_name="bookmark",
        uid_field="id",
        index_fields=["summary"],
        defaults={"status": "open"},
        indexed_by_default=True,
        parent_type=None,
        locations=["record"],
    )
    d = info.to_dict()
    assert d["type_name"] == "bookmark"
    assert d["indexed_by_default"] is True
    assert "schema_hash" in d

    restored = TypeInfo.from_dict(d)
    assert restored.type_name == info.type_name
    assert restored.indexed_by_default == info.indexed_by_default
    assert restored.index_fields == info.index_fields


def test_type_info_from_dict_uses_defaults():
    info = TypeInfo.from_dict({"type_name": "test"})
    assert info.uid_field == "id"
    assert info.index_fields == []
    assert info.defaults == {}
    assert info.indexed_by_default is False
    assert info.parent_type is None
    assert info.locations == []


# ---------------------------------------------------------------------------
# SchemaRegistry — registration
# ---------------------------------------------------------------------------


def test_register_and_get(tmp_path):
    _fresh_registry()
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        info = TypeInfo(type_name="test_type")
        SchemaRegistry.register(info)
        result = SchemaRegistry.get("test_type")
    assert result is not None
    assert result.type_name == "test_type"
    _fresh_registry()


def test_register_idempotent_merges_locations(tmp_path):
    _fresh_registry()
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        SchemaRegistry.register(TypeInfo(type_name="t", locations=["record"]))
        SchemaRegistry.register(TypeInfo(type_name="t", locations=["index"]))
        info = SchemaRegistry.get("t")
    assert "record" in info.locations
    assert "index" in info.locations
    _fresh_registry()


def test_register_idempotent_merges_record_cls(tmp_path):
    _fresh_registry()
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):

        class FakeRecordCls:
            pass

        SchemaRegistry.register(TypeInfo(type_name="t"))
        SchemaRegistry.register(TypeInfo(type_name="t", record_cls=FakeRecordCls))
        info = SchemaRegistry.get("t")
    assert info.record_cls is FakeRecordCls
    _fresh_registry()


def test_register_parent_type_builds_subtypes(tmp_path):
    _fresh_registry()
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        SchemaRegistry.register(TypeInfo(type_name="parent"))
        SchemaRegistry.register(TypeInfo(type_name="child", parent_type="parent"))
        subtypes = SchemaRegistry.get_subtypes("parent")
    assert len(subtypes) == 1
    assert subtypes[0].type_name == "child"
    _fresh_registry()


def test_get_all_types(tmp_path):
    _fresh_registry()
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        SchemaRegistry.register(TypeInfo(type_name="a"))
        SchemaRegistry.register(TypeInfo(type_name="b"))
        all_types = SchemaRegistry.get_all_types()
    assert "a" in all_types
    assert "b" in all_types
    _fresh_registry()


def test_get_returns_none_for_unknown():
    assert SchemaRegistry.get("this_type_does_not_exist_xyz") is None


def test_indexed_by_default_accumulates(tmp_path):
    _fresh_registry()
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        SchemaRegistry.register(TypeInfo(type_name="x", indexed_by_default=True))
        SchemaRegistry.register(TypeInfo(type_name="y", indexed_by_default=True))
        result = SchemaRegistry.get_default_index_types()
    assert "x" in result
    assert "y" in result
    _fresh_registry()


def test_get_default_index_types_fallback_when_empty():
    _fresh_registry()
    result = SchemaRegistry.get_default_index_types()
    assert "skill" in result
    assert "bookmark" in result
    _fresh_registry()


# ---------------------------------------------------------------------------
# SchemaRegistry — persistence
# ---------------------------------------------------------------------------


def test_persist_writes_type_info_json(tmp_path):
    _fresh_registry()
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        SchemaRegistry.register(TypeInfo(type_name="persist_me", locations=["record"]))
    json_file = tmp_path / "types" / "persist_me" / "type_info.json"
    assert json_file.exists()
    data = json.loads(json_file.read_text())
    assert data["type_name"] == "persist_me"
    _fresh_registry()


def test_persist_skips_if_hash_unchanged(tmp_path):
    _fresh_registry()
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        info = TypeInfo(type_name="stable")
        SchemaRegistry.register(info)
        json_file = tmp_path / "types" / "stable" / "type_info.json"
        mtime1 = json_file.stat().st_mtime

        # Re-register same info — hash unchanged, file should NOT be rewritten
        import time

        time.sleep(0.01)
        SchemaRegistry.register(info)
        mtime2 = json_file.stat().st_mtime
    assert mtime1 == mtime2
    _fresh_registry()


def test_load_persisted_restores_types(tmp_path):
    _fresh_registry()
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        SchemaRegistry.register(TypeInfo(type_name="loaded_type", indexed_by_default=True))

    _fresh_registry()
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        SchemaRegistry.load_persisted()
        info = SchemaRegistry.get("loaded_type")
    assert info is not None
    assert info.type_name == "loaded_type"
    _fresh_registry()


# ---------------------------------------------------------------------------
# SchemaRegistry — logging (append_scan / append_index / get_last_*)
# ---------------------------------------------------------------------------


def test_append_scan_global_log(tmp_path):
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        ts = SchemaRegistry.append_scan(
            trigger="test",
            duration_ms=10.0,
            total_records=5,
            total_bytes=512,
            types=[],
        )
    log = tmp_path / "scan_log.jsonl"
    assert log.exists()
    entry = json.loads(log.read_text().strip().splitlines()[-1])
    assert entry["scan_trigger"] == "test"
    assert entry["total_records"] == 5
    assert entry["created_at"] == ts


def test_append_scan_per_type_log(tmp_path):
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        ts = SchemaRegistry.append_scan(
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


def test_append_index_global_and_per_type(tmp_path):
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        ts = SchemaRegistry.append_index(
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


def test_get_last_scan_at_none_when_missing(tmp_path):
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        result = SchemaRegistry.get_last_scan_at("nonexistent_type")
    assert result is None


def test_get_last_index_at_returns_timestamp(tmp_path):
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        ts = SchemaRegistry.append_index(
            trigger="t",
            duration_ms=1.0,
            total_indexed=1,
            types=[],
            type_name="skill",
        )
        result = SchemaRegistry.get_last_index_at("skill")
    assert result == ts


def test_get_last_global_index_at_none_when_no_log(tmp_path):
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        result = SchemaRegistry.get_last_global_index_at()
    assert result is None


def test_get_last_global_index_at_returns_last(tmp_path):
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        ts = SchemaRegistry.append_index(
            trigger="global_test",
            duration_ms=5.0,
            total_indexed=10,
            types=[],
        )
        result = SchemaRegistry.get_last_global_index_at()
    assert result == ts


# ---------------------------------------------------------------------------
# SchemaRegistry — get_index_status
# ---------------------------------------------------------------------------


def test_get_index_status_never_indexed(tmp_path):
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        status = SchemaRegistry.get_index_status()
    assert status.never_indexed is True
    assert status.last_indexed_at is None
    assert status.stale is False


def test_get_index_status_stale_when_old(tmp_path):
    old_time = "2020-01-01T00:00:00+00:00"
    with (
        patch.object(SchemaRegistry, "get_last_global_index_at", return_value=old_time),
        patch.object(SchemaRegistry, "get_last_index_at", return_value=old_time),
        patch.object(SchemaRegistry, "get_last_scan_at", return_value=old_time),
    ):
        status = SchemaRegistry.get_index_status()
    assert status.stale is True
    assert all(t.stale for t in status.per_type)


def test_get_index_status_not_stale_when_recent(tmp_path):
    now = datetime.now(timezone.utc).isoformat()
    with (
        patch.object(SchemaRegistry, "get_last_global_index_at", return_value=now),
        patch.object(SchemaRegistry, "get_last_index_at", return_value=now),
        patch.object(SchemaRegistry, "get_last_scan_at", return_value=now),
    ):
        status = SchemaRegistry.get_index_status()
    assert status.stale is False
    assert not any(t.stale for t in status.per_type)


# ---------------------------------------------------------------------------
# SchemaRegistry — TypeInfo.scans property
# ---------------------------------------------------------------------------


def test_type_info_scans_reads_from_log(tmp_path):
    _fresh_registry()
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        SchemaRegistry.register(TypeInfo(type_name="scanned_type"))
        SchemaRegistry.append_scan(
            trigger="test",
            duration_ms=1.0,
            total_records=1,
            total_bytes=100,
            types=[],
            type_name="scanned_type",
        )
        info = SchemaRegistry.get("scanned_type")
        scans = info.scans
    assert len(scans) == 1
    assert scans[0]["scan_trigger"] == "test"
    _fresh_registry()


# ---------------------------------------------------------------------------
# SchemaRegistry — TypeInfo.extends / subtypes via registry
# ---------------------------------------------------------------------------


def test_type_info_extends_returns_parent(tmp_path):
    _fresh_registry()
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        SchemaRegistry.register(TypeInfo(type_name="base_type"))
        SchemaRegistry.register(TypeInfo(type_name="derived_type", parent_type="base_type"))
        child_info = SchemaRegistry.get("derived_type")
        parent_info = child_info.extends
    assert parent_info is not None
    assert parent_info.type_name == "base_type"
    _fresh_registry()


def test_type_info_subtypes_returns_children(tmp_path):
    _fresh_registry()
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        SchemaRegistry.register(TypeInfo(type_name="root"))
        SchemaRegistry.register(TypeInfo(type_name="child1", parent_type="root"))
        SchemaRegistry.register(TypeInfo(type_name="child2", parent_type="root"))
        root_info = SchemaRegistry.get("root")
        children = root_info.subtypes
    assert len(children) == 2
    names = {c.type_name for c in children}
    assert names == {"child1", "child2"}
    _fresh_registry()


# ---------------------------------------------------------------------------
# JSONL helpers
# ---------------------------------------------------------------------------


def test_trim_jsonl_keeps_last_100(tmp_path):
    log_path = tmp_path / "test.jsonl"
    for i in range(110):
        _append_jsonl(log_path, {"i": i})
    lines = log_path.read_text().strip().splitlines()
    assert len(lines) == 100
    assert json.loads(lines[0])["i"] == 10
    assert json.loads(lines[-1])["i"] == 109


def test_read_last_entry_returns_none_when_missing(tmp_path):
    result = _read_last_entry(tmp_path / "no_such_file.jsonl")
    assert result is None


def test_read_last_entry_returns_last_line(tmp_path):
    log = tmp_path / "log.jsonl"
    _append_jsonl(log, {"x": 1})
    _append_jsonl(log, {"x": 2})
    result = _read_last_entry(log)
    assert result["x"] == 2


# ---------------------------------------------------------------------------
# TypeInfo.type_id / SchemaRegistry.get(TypeId)
# ---------------------------------------------------------------------------


def test_type_info_type_id():
    info = TypeInfo(type_name="skill", locations=["record"])
    tid = info.type_id
    assert tid.type == "skill"
    assert str(tid).startswith("skill-")


def test_schema_registry_get_accepts_typeid(tmp_path):
    _fresh_registry()
    with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
        SchemaRegistry.register(TypeInfo(type_name="skill_x", locations=["record"]))
        tid = TypeId("skill_x-@local")
        info = SchemaRegistry.get(tid)
    assert info is not None
    assert info.type_name == "skill_x"
    _fresh_registry()
