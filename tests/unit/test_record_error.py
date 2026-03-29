"""Tests for RecordError — structured error record for indexing failures."""
from __future__ import annotations

import json
import time
from typing import ClassVar
from unittest.mock import patch, MagicMock

import pytest

from flow_sdk.fs_store.record import Record
from flow_sdk.fs_records.record_error import RecordError


def _suppress_claude_sync(tmp_path):
    """Prevent ClaudeErrorRecord._do_sync() from reading real debug logs.

    Writes a fresh _sync_state.json so the throttle fires and skips the scan.
    """
    claude_dir = tmp_path / "claude_error"
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / "_sync_state.json").write_text(
        json.dumps({"processed": {}, "last_sync_ts": time.time()}),
        encoding="utf-8",
    )


class FakeRecord(Record):
    _record_type: ClassVar[str] = "fake_for_error"


class TestRecordError:
    def test_from_exception_captures_fields(self):
        rec = FakeRecord(id="rec-1", type="fake_for_error", name="Test")
        exc = ValueError("something broke")
        error = RecordError.from_exception(rec, exc, trigger="index")

        assert error.source_record_id == "rec-1"
        assert error.source_record_type == "fake_for_error"
        assert error.error_message == "something broke"
        assert error.error_type == "ValueError"
        assert error.trigger == "index"
        assert error.occurred_at is not None

    def test_record_error_saves_to_disk(self, tmp_path):
        from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            rec = FakeRecord(id="rec-2", type="fake_for_error")
            exc = RuntimeError("disk full")
            error = RecordError.from_exception(rec, exc, trigger="index")
            error.save()

            # Verify it was saved
            assert error.source_file is not None or error.path is not None
        finally:
            set_default_records_root(old_root)

    @pytest.mark.asyncio
    async def test_clear_for_type_removes_matching(self, tmp_path):
        from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        _suppress_claude_sync(tmp_path)
        try:
            # Create two errors for different types
            rec1 = FakeRecord(id="rec-a", type="fake_for_error")
            err1 = RecordError.from_exception(rec1, ValueError("err1"), trigger="index")
            err1.save()

            rec2 = FakeRecord(id="rec-b", type="other_type")
            rec2.type = "other_type"
            err2 = RecordError.from_exception(rec2, ValueError("err2"), trigger="index")
            err2.save()

            removed = await RecordError.clear_for_type("fake_for_error")
            assert removed == 1

            remaining = list(RecordError.discover())
            assert len(remaining) == 1
            assert remaining[0].source_record_type == "other_type"
        finally:
            set_default_records_root(old_root)

    @pytest.mark.asyncio
    async def test_clear_all_removes_everything(self, tmp_path):
        from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        _suppress_claude_sync(tmp_path)
        try:
            rec = FakeRecord(id="rec-c", type="fake_for_error")
            err1 = RecordError.from_exception(rec, ValueError("e1"), trigger="index")
            err1.save()
            err2 = RecordError.from_exception(rec, ValueError("e2"), trigger="index")
            err2.save()

            removed = await RecordError.clear_all()
            assert removed == 2
            assert len(list(RecordError.discover())) == 0
        finally:
            set_default_records_root(old_root)

    def test_discover_returns_all_errors(self, tmp_path):
        from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        _suppress_claude_sync(tmp_path)
        try:
            rec = FakeRecord(id="rec-d", type="fake_for_error")
            for i in range(3):
                err = RecordError.from_exception(rec, ValueError(f"e{i}"), trigger="index")
                err.save()

            errors = list(RecordError.discover())
            assert len(errors) == 3
        finally:
            set_default_records_root(old_root)

    def test_claude_error_record_is_instance_of_record_error(self):
        """After class change, isinstance check holds."""
        from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord
        rec = ClaudeErrorRecord(fingerprint="abc", error_msg="boom", first_seen="2026-01-01T00:00:00+00:00")
        assert isinstance(rec, RecordError)

    def test_claude_error_record_has_common_fields(self):
        """ClaudeErrorRecord exposes the RecordError common interface."""
        from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord
        rec = ClaudeErrorRecord(fingerprint="abc", error_msg="test error", first_seen="2026-01-01T00:00:00+00:00")
        assert rec.error_message == "test error"
        assert rec.occurred_at == "2026-01-01T00:00:00+00:00"
        assert rec.trigger == "claude_debug"

    @pytest.mark.asyncio
    async def test_clear_all_does_not_touch_subtypes(self, tmp_path):
        """RecordError.clear_all() removes only its own records, not ClaudeErrorRecords."""
        from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root
        from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord
        from flow_sdk.fs_store.resource_record_list import ResourceRecordList

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            # Save a RecordError
            rec = FakeRecord(id="x", type="fake_for_error")
            err = RecordError.from_exception(rec, ValueError("x"), trigger="index")
            err.save()

            # Directly save a ClaudeErrorRecord to disk (bypass sync)
            claude_rec = ClaudeErrorRecord(fingerprint="fp1", error_msg="hook error", first_seen="2026-01-01T00:00:00+00:00")
            claude_rec.id = "fp1"
            backing = ResourceRecordList(list_path=tmp_path / "claude_error", record_class=ClaudeErrorRecord)
            backing.create(claude_rec)

            await RecordError.clear_all()

            # RecordError gone (own records only)
            own_errors = list(super(RecordError, RecordError).discover.__func__(RecordError))
            assert own_errors == []
            # ClaudeErrorRecord still on disk
            assert backing.get("fp1") is not None
        finally:
            set_default_records_root(old_root)
