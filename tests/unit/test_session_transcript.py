"""Unit tests for ClaudeSessionRecord.to_transcript_dicts and session-transcript action."""

from unittest.mock import MagicMock, patch

import pytest

from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord


class FakeEntry:
    """Fake transcript entry with meta_dict()."""

    def __init__(self, entry_type: str, entry_uuid: str, raw_json: dict | None = None):
        self._entry_type = entry_type
        self._entry_uuid = entry_uuid
        self._raw_json = raw_json or {"big": "payload"}

    @property
    def entry_type(self) -> str:
        return self._entry_type

    def meta_dict(self) -> dict:
        return {
            "entry_type": self._entry_type,
            "entry_uuid": self._entry_uuid,
            "timestamp": "2026-03-08T00:00:00Z",
            "session_id": "sess-1",
            "raw_json": self._raw_json,
        }


@pytest.fixture
def session_with_entries():
    """Create a ClaudeSessionRecord with mocked filtered_entries."""
    rec = ClaudeSessionRecord(session_id="sess-1")
    entries = [
        FakeEntry("user", "uuid-1"),
        FakeEntry("assistant", "uuid-2"),
    ]
    # Patch the filtered_entries property
    with patch.object(
        ClaudeSessionRecord, "filtered_entries", new_callable=lambda: property(lambda self: entries)
    ):
        yield rec, entries


def test_to_transcript_dicts_excludes_raw_json_by_default(session_with_entries):
    rec, _ = session_with_entries
    result = rec.to_transcript_dicts()
    assert len(result) == 2
    for entry_dict in result:
        assert "raw_json" not in entry_dict
        assert "entry_type" in entry_dict
        assert "entry_uuid" in entry_dict
        assert "timestamp" in entry_dict


def test_to_transcript_dicts_includes_raw_json_when_requested(session_with_entries):
    rec, _ = session_with_entries
    result = rec.to_transcript_dicts(include_raw_json=True)
    assert len(result) == 2
    for entry_dict in result:
        assert "raw_json" in entry_dict
        assert entry_dict["raw_json"] == {"big": "payload"}


def test_to_transcript_dicts_empty_session():
    rec = ClaudeSessionRecord(session_id="sess-empty")
    with patch.object(
        ClaudeSessionRecord,
        "filtered_entries",
        new_callable=lambda: property(lambda self: []),
    ):
        result = rec.to_transcript_dicts()
    assert result == []


def test_to_transcript_dicts_preserves_all_fields_except_raw_json(session_with_entries):
    rec, _ = session_with_entries
    result = rec.to_transcript_dicts()
    expected_keys = {"entry_type", "entry_uuid", "timestamp", "session_id"}
    for entry_dict in result:
        assert set(entry_dict.keys()) == expected_keys
