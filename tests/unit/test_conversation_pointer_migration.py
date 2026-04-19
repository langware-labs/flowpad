"""Tests for ConversationRecord pointer-index methods.

Verifies that:
1. append_message_pointer writes a pointer line to the JSONL file
2. message_pointers() returns all lines (all lines are pointers)
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.fs_records.conversation_record import ConversationRecord


def _make_record(jsonl_path: Path, task_id: str = "task-abc", record_id: str = "conv-abc") -> ConversationRecord:
    return ConversationRecord.from_jsonl(jsonl_path, task_id, record_id)


# ---------------------------------------------------------------------------
# append_message_pointer
# ---------------------------------------------------------------------------

class TestAppendMessagePointer:
    def test_appends_pointer_line(self, tmp_path):
        """append_message_pointer writes a JSON line with message_id and timestamp."""
        jsonl = tmp_path / "conversation.jsonl"
        jsonl.write_text("")

        rec = _make_record(jsonl)
        rec.append_message_pointer("fm-id-001", "2026-01-01T00:00:00+00:00")

        lines = [l.strip() for l in jsonl.read_text().splitlines() if l.strip()]
        assert len(lines) == 1
        obj = json.loads(lines[0])
        assert obj == {"message_id": "fm-id-001", "timestamp": "2026-01-01T00:00:00+00:00"}

    def test_appends_multiple_pointers(self, tmp_path):
        """Multiple calls append multiple lines."""
        jsonl = tmp_path / "conversation.jsonl"
        jsonl.write_text("")

        rec = _make_record(jsonl)
        rec.append_message_pointer("fm-001", "2026-01-01T00:00:00+00:00")
        rec.append_message_pointer("fm-002", "2026-01-02T00:00:00+00:00")

        lines = [l.strip() for l in jsonl.read_text().splitlines() if l.strip()]
        assert len(lines) == 2

    def test_raises_if_no_data_path(self):
        """append_message_pointer raises ValueError if data_path is not set."""
        rec = ConversationRecord(type="conversation")
        with pytest.raises(ValueError, match="no data_path"):
            rec.append_message_pointer("fm-001", "2026-01-01T00:00:00+00:00")

    def test_creates_parent_dirs(self, tmp_path):
        """append_message_pointer creates parent directories if needed."""
        jsonl = tmp_path / "subdir" / "deep" / "conversation.jsonl"

        rec = _make_record(jsonl)
        rec.append_message_pointer("fm-001", "2026-01-01T00:00:00+00:00")

        assert jsonl.exists()


# ---------------------------------------------------------------------------
# message_pointers
# ---------------------------------------------------------------------------

class TestMessagePointers:
    def test_returns_all_pointer_lines(self, tmp_path):
        """message_pointers() returns all lines in the jsonl index."""
        jsonl = tmp_path / "conversation.jsonl"
        jsonl.write_text(
            json.dumps({"message_id": "fm-001", "timestamp": "2026-01-01T01:00:00Z"}) + "\n" +
            json.dumps({"message_id": "fm-002", "timestamp": "2026-01-01T02:00:00Z"}) + "\n"
        )

        rec = _make_record(jsonl)
        pointers = rec.message_pointers()
        assert len(pointers) == 2
        assert pointers[0]["message_id"] == "fm-001"
        assert pointers[1]["message_id"] == "fm-002"

    def test_empty_jsonl_returns_empty_list(self, tmp_path):
        """Empty JSONL returns empty list."""
        jsonl = tmp_path / "conversation.jsonl"
        jsonl.write_text("")

        rec = _make_record(jsonl)
        assert rec.message_pointers() == []

    def test_append_then_read(self, tmp_path):
        """Append two pointers, read them back via message_pointers()."""
        jsonl = tmp_path / "conversation.jsonl"
        jsonl.write_text("")

        rec = _make_record(jsonl)
        rec.append_message_pointer("fm-001", "2026-01-01T00:00:00+00:00")
        rec.append_message_pointer("fm-002", "2026-01-01T01:00:00+00:00")

        pointers = rec.message_pointers()
        assert len(pointers) == 2
        assert pointers[0]["message_id"] == "fm-001"
        assert pointers[1]["message_id"] == "fm-002"
