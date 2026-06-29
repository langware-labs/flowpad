"""Tests for conversation_record pointer-index free functions.

Verifies that:
1. append_message_pointer writes a typed Pointer line to the JSONL file
2. message_pointers() returns Pointer objects
"""
from __future__ import annotations

import json

from flow_sdk.fs_store.operations.conversation import (
    append_message_pointer,
    default_jsonl_path,
    from_jsonl,
    message_pointers,
)
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.pointer import Pointer


def _make_record(record_id: str = "conv-abc-12345678", task_id: str = "task-abc-12345678"):
    canonical = default_jsonl_path(record_id)
    canonical.parent.mkdir(parents=True, exist_ok=True)
    if canonical.exists():
        canonical.unlink()
    return from_jsonl(canonical, task_id, record_id)


class TestAppendMessagePointer:
    def test_appends_typed_pointer_line(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            "flow_sdk.fs_store.record_paths.get_default_records_data_root",
            lambda: tmp_path,
        )
        rec = _make_record(record_id="conv-typed-12345678")
        append_message_pointer(rec, "aaa11111-1111-1111-1111-111111111111", "2026-01-01T00:00:00+00:00")

        canonical = default_jsonl_path("conv-typed-12345678")
        lines = [l.strip() for l in canonical.read_text().splitlines() if l.strip()]
        assert len(lines) == 1
        obj = json.loads(lines[0])
        assert obj["typeid"] == "flow_message-aaa11111-1111-1111-1111-111111111111"
        assert obj["ts"] == "2026-01-01T00:00:00+00:00"

    def test_appends_multiple_pointers(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            "flow_sdk.fs_store.record_paths.get_default_records_data_root",
            lambda: tmp_path,
        )
        rec = _make_record(record_id="conv-multi-12345678")
        append_message_pointer(rec, "bbb11111-1111-1111-1111-111111111111", "2026-01-01T00:00:00+00:00")
        append_message_pointer(rec, "bbb22222-2222-2222-2222-222222222222", "2026-01-02T00:00:00+00:00")

        canonical = default_jsonl_path("conv-multi-12345678")
        lines = [l.strip() for l in canonical.read_text().splitlines() if l.strip()]
        assert len(lines) == 2

    def test_record_with_auto_id_resolves_canonical_path(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            "flow_sdk.fs_store.record_paths.get_default_records_data_root",
            lambda: tmp_path,
        )
        rec = FSRecord(type="conversation", id="conv-auto-12345678")
        path = default_jsonl_path(rec.id)
        assert path is not None
        assert str(tmp_path) in str(path)
        assert path.name == "conversation.jsonl"

    def test_creates_parent_dirs(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            "flow_sdk.fs_store.record_paths.get_default_records_data_root",
            lambda: tmp_path / "nested" / "deep",
        )
        rec = _make_record(record_id="conv-deep-12345678")
        append_message_pointer(rec, "bbb11111-1111-1111-1111-111111111111", "2026-01-01T00:00:00+00:00")
        canonical = default_jsonl_path("conv-deep-12345678")
        assert canonical.exists()


class TestMessagePointers:
    def test_returns_typed_pointers(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            "flow_sdk.fs_store.record_paths.get_default_records_data_root",
            lambda: tmp_path,
        )
        rec = _make_record(record_id="conv-typed-rd-12345678")
        canonical = default_jsonl_path("conv-typed-rd-12345678")
        canonical.write_text(
            json.dumps({"typeid": "flow_message-ccc11111-1111-1111-1111-111111111111", "ts": "2026-01-01T01:00:00Z"}) + "\n" +
            json.dumps({"typeid": "flow_message-ccc22222-2222-2222-2222-222222222222", "ts": "2026-01-01T02:00:00Z"}) + "\n"
        )

        pointers = message_pointers(rec)
        assert len(pointers) == 2
        assert all(isinstance(p, Pointer) for p in pointers)
        assert pointers[0].id == "ccc11111-1111-1111-1111-111111111111"
        assert pointers[0].type == "flow_message"
        assert pointers[1].id == "ccc22222-2222-2222-2222-222222222222"

    def test_empty_jsonl_returns_empty_list(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            "flow_sdk.fs_store.record_paths.get_default_records_data_root",
            lambda: tmp_path,
        )
        rec = _make_record(record_id="conv-empty-12345678")
        assert message_pointers(rec) == []

    def test_append_then_read(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            "flow_sdk.fs_store.record_paths.get_default_records_data_root",
            lambda: tmp_path,
        )
        rec = _make_record(record_id="conv-rt-12345678")
        append_message_pointer(rec, "bbb11111-1111-1111-1111-111111111111", "2026-01-01T00:00:00+00:00")
        append_message_pointer(rec, "bbb22222-2222-2222-2222-222222222222", "2026-01-01T01:00:00+00:00")

        pointers = message_pointers(rec)
        assert [p.id for p in pointers] == ["bbb11111-1111-1111-1111-111111111111", "bbb22222-2222-2222-2222-222222222222"]
