"""
Temp resilience tests: malformed JSON, missing files, missing fields,
DB down, no data, invalid record_data_ref.

Validates the record/entity system does not crash or silently corrupt data
under adverse conditions. Each section documents the actual behavior and
asserts it is predictable and safe.
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import ClassVar
from unittest.mock import AsyncMock, MagicMock, patch, call

import pytest

from flow_sdk.fs_store.record import Record, set_default_records_root, get_default_records_root
from flow_sdk.fs_records.record_error import RecordError
from flow_sdk.fs_records.schema_record import SchemaRecord, IndexResult, ClearResult


def _suppress_claude_sync(tmp_path):
    """Prevent ClaudeErrorRecord._do_sync() from reading real debug logs."""
    claude_dir = tmp_path / "claude_error"
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / "_sync_state.json").write_text(
        json.dumps({"processed": {}, "last_sync_ts": time.time()}),
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class SimpleRecord(Record):
    _record_type: ClassVar[str] = "simple_test_record"

    @property
    def content(self) -> str | None:
        return getattr(self, "body", None)


def _record(**kwargs) -> SimpleRecord:
    kwargs.setdefault("id", str(uuid.uuid4()))
    kwargs.setdefault("type", "simple_test_record")
    return SimpleRecord(**kwargs)


def _write_record_dir(base: Path, record_id: str, meta_text: str, data_text: str) -> Path:
    """Write a record folder with raw (possibly malformed) JSON text."""
    folder = base / "simple_test_record" / f"simple_test_record-@{record_id}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "metadata.json").write_text(meta_text, encoding="utf-8")
    data_dir = folder / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "_obj_data.json").write_text(data_text, encoding="utf-8")
    return folder


# ---------------------------------------------------------------------------
# 1. Malformed JSON
# ---------------------------------------------------------------------------

class TestMalformedJson:
    def test_load_malformed_metadata_does_not_crash(self, tmp_path):
        """Record.load() silently skips malformed metadata.json (returns partial record).
        This is intentional — a corrupted file should not crash the system.
        """
        old = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            folder = _write_record_dir(tmp_path, "bad-meta", "{broken json!!!", "{}")
            rec = SimpleRecord.load(folder)
            # Must not raise; record has auto-generated id (metadata was unreadable)
            assert rec is not None
            assert rec.id is not None  # auto-generated UUID
        finally:
            set_default_records_root(old)

    def test_load_malformed_metadata_heals_on_read(self, tmp_path):
        """When metadata.json is corrupt, the id is recovered from the folder name
        and a valid metadata.json is written back — subsequent loads return the same id.
        """
        old = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            real_id = "known-real-id"
            folder = _write_record_dir(tmp_path, real_id, "{broken json!!!", "{}")

            # First load — heals the file
            rec1 = SimpleRecord.load(folder)
            assert rec1 is not None
            assert rec1.id == real_id  # recovered from folder name

            # Second load — reads the now-valid metadata.json
            rec2 = SimpleRecord.load(folder)
            assert rec2.id == real_id  # stable — same id both times
        finally:
            set_default_records_root(old)

    def test_load_malformed_data_does_not_crash(self, tmp_path):
        """Record.load() silently skips malformed _obj_data.json — metadata still loads."""
        old = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            rid = str(uuid.uuid4())
            meta = json.dumps({"data": {"id": rid, "type": "simple_test_record", "name": "ok"}})
            folder = _write_record_dir(tmp_path, rid, meta, "[not a dict]")
            rec = SimpleRecord.load(folder)
            assert rec is not None
            # Metadata loaded; data was malformed but no crash
            assert rec.id == rid
        finally:
            set_default_records_root(old)



# ---------------------------------------------------------------------------
# 2. Missing files
# ---------------------------------------------------------------------------

class TestMissingFiles:
    def test_load_nonexistent_folder_raises(self, tmp_path):
        """Record.load() raises FileNotFoundError (or similar) for a missing path."""
        missing = tmp_path / "ghost-folder"
        with pytest.raises(Exception):
            SimpleRecord.load(missing)

    def test_get_returns_none_for_missing(self, tmp_path):
        """get() returns None when no record with that id exists."""
        old = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            result = SimpleRecord.get("does-not-exist")
            assert result is None
        finally:
            set_default_records_root(old)

    @pytest.mark.asyncio
    async def test_entity_store_creates_record_when_file_missing(self, tmp_path):
        """entity._store() creates a new record when none exists on disk (DB-first entities like Bookmark, Task)."""
        from flow_sdk.core.entity.entity_model import Entity
        from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root
        from unittest.mock import MagicMock

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            entity = MagicMock(spec=Entity)
            entity.get_type.return_value = "simple_test_record"
            entity.id = "ghost-id"
            entity.db_json.return_value = {"name": "New Record"}

            with patch("flow_sdk.fs_store.schema_registry.SchemaRegistry.get_record_cls", return_value=SimpleRecord):
                result = await Entity._store(entity)

            assert result is not None
            assert result.id == "ghost-id"
        finally:
            set_default_records_root(old_root)

    @pytest.mark.asyncio
    async def test_delete_by_record_ref_removed(self):
        """delete_by_record_ref() has been removed from Entity (Search-First refactor)."""
        from flow_sdk.core.entity.entity_model import Entity

        assert not hasattr(Entity, "delete_by_record_ref")

    @pytest.mark.asyncio
    async def test_unindex_noop_when_entity_missing(self):
        """record.unindex() is safe to call when entity doesn't exist in DB."""
        rec = _record(id="orphan-id")
        from flow_sdk.core.entity.entity_model import Entity

        with patch.object(Entity, "get_one", AsyncMock(return_value=None)):
            await rec.unindex()  # Must not raise


# ---------------------------------------------------------------------------
# 3. Missing fields (incomplete records)
# ---------------------------------------------------------------------------

class TestMissingFields:
    def test_meta_dict_only_returns_present_fields(self):
        """meta_dict() never includes None fields — safe with partial records."""
        rec = SimpleRecord(id="partial", type="simple_test_record")
        meta = rec.meta_dict()
        assert "id" in meta
        assert "type" in meta
        assert "name" not in meta
        assert "status" not in meta
        assert "created_date" not in meta

    def test_index_content_none_when_body_missing(self):
        """index_content() returns None for a record with no searchable content."""
        rec = _record()
        assert rec.index_content() is None

    def test_record_type_classmethod_never_raises(self):
        """record_type() always returns a string, even for the base class."""
        assert isinstance(SimpleRecord.record_type(), str)
        assert SimpleRecord.record_type() == "simple_test_record"

    def test_from_record_meta_dict_is_well_formed_for_minimal_record(self):
        """A minimal record (only id+type) produces a safe, clean meta_dict()."""
        rec = SimpleRecord(id="min-id", type="simple_test_record")
        meta = rec.meta_dict()
        assert meta["id"] == "min-id"
        assert meta["type"] == "simple_test_record"
        assert "name" not in meta   # Not present → safe to omit
        assert "status" not in meta
        assert rec.record_type() == "simple_test_record"
        assert rec.index_content() is None  # No body set


# ---------------------------------------------------------------------------
# 4. DB down (no session_factory)
# ---------------------------------------------------------------------------

class TestDbDown:
    def _make_driver(self):
        from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver
        d = SQLiteDBDriver.__new__(SQLiteDBDriver)
        object.__setattr__(d, "session_factory", None)
        return d

    @pytest.mark.asyncio
    async def test_fts_clear_returns_zero_when_no_session(self):
        """fts_clear() returns 0 when session_factory is None (DB not initialized)."""
        result = await self._make_driver().fts_clear()
        assert result == 0

    @pytest.mark.asyncio
    async def test_delete_entities_by_type_returns_zero_when_no_session(self):
        """delete_entities_by_type() returns 0 when session_factory is None."""
        result = await self._make_driver().delete_entities_by_type("skill")
        assert result == 0

    @pytest.mark.asyncio
    async def test_delete_entities_all_types_returns_zero_when_no_session(self):
        """delete_entities_by_type(None) returns 0 when session_factory is None."""
        result = await self._make_driver().delete_entities_by_type(None)
        assert result == 0

    @pytest.mark.asyncio
    async def test_count_entities_returns_zero_when_no_session(self):
        """count_entities_by_type() returns 0 when session_factory is None."""
        result = await self._make_driver().count_entities_by_type("skill")
        assert result == 0

    @pytest.mark.asyncio
    async def test_clear_index_survives_db_down(self):
        """SchemaRecord.clear_index() returns a valid ClearResult even when DB has no session."""
        from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver
        driver = self._make_driver()

        with patch("flow_sdk.db.get_db_driver", return_value=driver), \
             patch.object(RecordError, "clear_all", return_value=0):
            result = await SchemaRecord.clear_index(types=None)

        assert result.fts_cleared == 0
        assert result.entities_cleared == 0


# ---------------------------------------------------------------------------
# 5. No data (empty collections)
# ---------------------------------------------------------------------------

class TestNoData:
    def test_record_error_discover_empty(self, tmp_path):
        """RecordError.discover() returns [] when no error records exist on disk."""
        old = get_default_records_root()
        set_default_records_root(tmp_path)
        _suppress_claude_sync(tmp_path)
        try:
            errors = RecordError.discover()
            assert errors == []
        finally:
            set_default_records_root(old)

    @pytest.mark.asyncio
    async def test_record_error_clear_all_on_empty(self, tmp_path):
        """RecordError.clear_all() returns 0 when there are no error records."""
        old = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            count = await RecordError.clear_all()
            assert count == 0
        finally:
            set_default_records_root(old)

    @pytest.mark.asyncio
    async def test_record_error_clear_for_type_on_empty(self, tmp_path):
        """RecordError.clear_for_type() returns 0 when there are no errors for that type."""
        old = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            count = await RecordError.clear_for_type("skill")
            assert count == 0
        finally:
            set_default_records_root(old)

    @pytest.mark.asyncio
    async def test_get_index_status_never_indexed(self, tmp_path):
        """get_index_status() returns never_indexed=True when no log files exist."""
        with patch("flow_sdk.fs_store.schema_registry._schema_dir", lambda: tmp_path):
            status = await SchemaRecord.get_index_status()
        assert status.never_indexed is True
        assert status.last_indexed_at is None
        assert status.stale is False

# ---------------------------------------------------------------------------
# 6. Invalid record_data_ref
# ---------------------------------------------------------------------------

class TestInvalidDataRef:
    @pytest.mark.asyncio
    async def test_delete_by_record_ref_method_removed(self):
        """delete_by_record_ref() has been removed from Entity (Search-First refactor)."""
        from flow_sdk.core.entity.entity_model import Entity

        assert not hasattr(Entity, "delete_by_record_ref")

    @pytest.mark.asyncio
    async def test_entity_store_with_no_record_data_ref_returns_none(self):
        """entity._store() returns None immediately when record_data_ref is not set."""
        from flow_sdk.core.entity.entity_model import Entity
        from unittest.mock import MagicMock

        entity = MagicMock(spec=Entity)
        entity.record_data_ref = None

        result = await Entity._store(entity)
        assert result is None

    @pytest.mark.asyncio
    async def test_unindex_with_record_that_has_no_type(self):
        """record.unindex() uses uid to look up entity when type missing from data."""
        rec = SimpleRecord.__new__(SimpleRecord)
        object.__setattr__(rec, "_data", {"id": "test-id"})  # no 'type' key

        from flow_sdk.core.entity.entity_model import Entity

        with patch.object(Entity, "get_one", AsyncMock(return_value=None)):
            await rec.unindex()  # Must not raise — entity not found is safe

    def test_record_error_from_exception_no_traceback(self):
        """RecordError.from_exception() handles an exception with no __traceback__."""
        rec = _record(id="err-rec")
        exc = ValueError("something bad")
        # exc.__traceback__ is None (never raised through the stack)
        err = RecordError.from_exception(rec, exc, trigger="test")

        assert err.source_record_id == rec.id
        assert err.source_record_type == "simple_test_record"
        assert err.error_message == "something bad"
        assert err.error_type == "ValueError"
        assert err.trigger == "test"
        assert err.occurred_at is not None
        # No crash even with empty traceback
        assert err.error_traceback is not None  # May be empty string but not None

    def test_record_error_saves_to_disk(self, tmp_path):
        """RecordError.save() writes the error record to disk correctly."""
        old = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            rec = _record(id="save-test")
            exc = RuntimeError("write failed")
            err = RecordError.from_exception(rec, exc, trigger="test")
            err.save()

            # Verify something was written under tmp_path
            written = list(tmp_path.rglob("metadata.json"))
            assert len(written) >= 1
        finally:
            set_default_records_root(old)

    @pytest.mark.asyncio
    async def test_entity_store_disk_failure_creates_record_error(self):
        """entity._store() creates a RecordError and returns None when record.save() raises."""
        from flow_sdk.core.entity.entity_model import Entity
        from unittest.mock import MagicMock

        entity = MagicMock(spec=Entity)
        entity.get_type.return_value = "simple_test_record"
        entity.id = "disk-fail"

        saved_errors = []

        with patch("flow_sdk.fs_store.schema_registry.SchemaRegistry.get_record_cls", return_value=SimpleRecord), \
             patch.object(SimpleRecord, "get", return_value=_record(id="disk-fail")), \
             patch("asyncio.to_thread", side_effect=OSError("disk full")), \
             patch.object(RecordError, "save", lambda self: saved_errors.append(self)):
            result = await Entity._store(entity)

        assert result is None
        assert len(saved_errors) == 1
        assert saved_errors[0].trigger == "store"
        assert "disk full" in saved_errors[0].error_message

    def test_delete_entities_by_type_is_unconditional(self):
        """delete_entities_by_type deletes by type without record_data_ref filtering.
        Bootstrap entity preservation is handled at the call-site (SchemaRegistry
        only calls this for record-backed types).
        """
        import inspect
        from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver
        source = inspect.getsource(SQLiteDBDriver.delete_entities_by_type)
        assert "record_data_ref IS NOT NULL" not in source, (
            "delete_entities_by_type should no longer guard with 'record_data_ref IS NOT NULL'; "
            "record_data_ref has been removed as an active concept"
        )
