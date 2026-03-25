"""Tests for SchemaRecord orchestrator methods: index_type, clear_index, rebuild_index, get_index_status, get_errors."""

from __future__ import annotations

import json
import time
from typing import ClassVar
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.fs_records.schema_record import ClearResult, IndexResult, SchemaRecord
from flow_sdk.fs_store.record import Record


def _suppress_claude_sync(tmp_path):
    """Prevent ClaudeErrorRecord._do_sync() from reading real debug logs."""
    claude_dir = tmp_path / "claude_error"
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / "_sync_state.json").write_text(
        json.dumps({"processed": {}, "last_sync_ts": time.time()}),
        encoding="utf-8",
    )


class FakeIndexableRecord(Record):
    _record_type: ClassVar[str] = "fake_indexable"

    @property
    def content(self) -> str | None:
        return "searchable content"


class FakeFailingRecord(Record):
    _record_type: ClassVar[str] = "fake_failing"


class TestIndexType:
    @pytest.mark.asyncio
    async def test_index_type_indexes_all_records(self):
        recs = [FakeIndexableRecord(id=f"r{i}") for i in range(3)]
        for r in recs:
            object.__setattr__(r, "sync_to_db", AsyncMock())

        with patch(
            "flow_sdk.fs_store.record_list.RecordList.__iter__",
            return_value=iter(recs),
        ):
            result = await SchemaRecord.index_type(FakeIndexableRecord)

        assert result.indexed == 3
        assert result.skipped == 0
        assert result.errors == 0
        assert result.type_name == "fake_indexable"

    @pytest.mark.asyncio
    async def test_index_type_creates_record_error_on_failure(self, tmp_path):
        from flow_sdk.fs_store.record import get_default_records_root, set_default_records_root

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        _suppress_claude_sync(tmp_path)
        try:
            rec = FakeFailingRecord(id="fail-1")

            with (
                patch(
                    "flow_sdk.fs_store.record_list.RecordList.__iter__",
                    return_value=iter([rec]),
                ),
                patch(
                    "flow_sdk.core.entity.entity_model.Entity.from_record",
                    AsyncMock(side_effect=RuntimeError("boom")),
                ),
            ):
                result = await SchemaRecord.index_type(FakeFailingRecord)

            assert result.indexed == 0
            assert result.skipped == 1
            assert result.errors == 1

            # Verify a RecordError was persisted (created inside rec.sync_to_db())
            from flow_sdk.fs_records.record_error import RecordError

            errors = list(RecordError.discover())
            assert len(errors) == 1
            assert errors[0].error_message == "boom"
        finally:
            set_default_records_root(old_root)

    @pytest.mark.asyncio
    async def test_index_type_clear_first_removes_existing(self):
        rec = FakeIndexableRecord(id="r1")
        object.__setattr__(rec, "sync_to_db", AsyncMock())

        mock_driver = MagicMock()
        mock_driver.delete_entities_by_type = AsyncMock(return_value=5)

        with (
            patch(
                "flow_sdk.fs_store.record_list.RecordList.__iter__",
                return_value=iter([rec]),
            ),
            patch(
                "flow_sdk.db.get_db_driver",
                return_value=mock_driver,
            ),
        ):
            result = await SchemaRecord.index_type(FakeIndexableRecord, clear_first=True)

        mock_driver.delete_entities_by_type.assert_called_once_with("fake_indexable")
        assert result.indexed == 1


class TestClearIndex:
    @pytest.mark.asyncio
    async def test_clear_index_removes_fts_and_entities(self, tmp_path):
        mock_driver = MagicMock()
        mock_driver.fts_clear = AsyncMock(return_value=10)
        mock_driver.delete_entities_by_type = AsyncMock(return_value=5)

        schema_dir = tmp_path / "schema"
        schema_dir.mkdir()

        with (
            patch(
                "flow_sdk.db.get_db_driver",
                return_value=mock_driver,
            ),
            patch(
                "flow_sdk.fs_records.record_error.RecordError.clear_all",
                return_value=0,
            ),
            patch(
                "flow_sdk.fs_store.factory.type_registry.type_registry.get_all_types",
                return_value=["skill", "bookmark"],
            ),
            patch(
                "flow_sdk.fs_store.schema_registry.SCHEMA_DIR",
                schema_dir,
            ),
        ):
            result = await SchemaRecord.clear_index()

        assert result.fts_cleared == 10
        assert result.entities_cleared == 5

    @pytest.mark.asyncio
    async def test_clear_index_removes_log_files(self, tmp_path):
        schema_dir = tmp_path / "schema"
        types_dir = schema_dir / "types" / "skill"
        types_dir.mkdir(parents=True)
        log_file = types_dir / "index_log.jsonl"
        log_file.write_text("{}\n")

        mock_driver = MagicMock()
        mock_driver.delete_entities_by_type = AsyncMock(return_value=0)

        with (
            patch(
                "flow_sdk.db.get_db_driver",
                return_value=mock_driver,
            ),
            patch(
                "flow_sdk.fs_records.record_error.RecordError.clear_for_type",
                return_value=0,
            ),
            patch(
                "flow_sdk.fs_store.schema_registry.SCHEMA_DIR",
                schema_dir,
            ),
        ):
            result = await SchemaRecord.clear_index(types=["skill"])

        assert not log_file.exists()
        assert "skill" in result.types_cleared

    @pytest.mark.asyncio
    async def test_clear_index_preserves_bootstrap_entities(self, tmp_path):
        """delete_entities_by_type uses record_data_ref IS NOT NULL filter, preserving bootstrap."""
        mock_driver = MagicMock()
        mock_driver.fts_clear = AsyncMock(return_value=0)
        mock_driver.delete_entities_by_type = AsyncMock(return_value=0)

        schema_dir = tmp_path / "schema"
        schema_dir.mkdir()

        with (
            patch(
                "flow_sdk.db.get_db_driver",
                return_value=mock_driver,
            ),
            patch(
                "flow_sdk.fs_records.record_error.RecordError.clear_all",
                return_value=0,
            ),
            patch(
                "flow_sdk.fs_store.factory.type_registry.type_registry.get_all_types",
                return_value=[],
            ),
            patch(
                "flow_sdk.fs_store.schema_registry.SCHEMA_DIR",
                schema_dir,
            ),
        ):
            await SchemaRecord.clear_index()

        mock_driver.delete_entities_by_type.assert_called_once_with(None)


class TestRebuildIndex:
    @pytest.mark.asyncio
    async def test_rebuild_clears_then_indexes(self):
        mock_clear = AsyncMock(return_value=ClearResult(fts_cleared=5, entities_cleared=3, types_cleared=["skill"]))
        mock_index_type = AsyncMock(
            return_value=IndexResult(type_name="skill", indexed=10, skipped=0, duration_ms=100.0, errors=0)
        )

        with (
            patch.object(SchemaRecord, "clear_index", mock_clear),
            patch.object(SchemaRecord, "index_type", mock_index_type),
            patch.object(SchemaRecord, "append_index"),
            patch("flow_sdk.fs_store.factory.type_registry.type_registry.get", return_value=FakeIndexableRecord),
        ):
            clear_result, index_results = await SchemaRecord.rebuild_index(types=["skill"])

        assert clear_result.fts_cleared == 5
        assert len(index_results) == 1
        assert index_results[0].indexed == 10

    @pytest.mark.asyncio
    async def test_rebuild_idempotent(self):
        mock_clear = AsyncMock(return_value=ClearResult(fts_cleared=0, entities_cleared=0, types_cleared=[]))
        mock_index_type = AsyncMock(
            return_value=IndexResult(type_name="skill", indexed=5, skipped=0, duration_ms=50.0, errors=0)
        )

        with (
            patch.object(SchemaRecord, "clear_index", mock_clear),
            patch.object(SchemaRecord, "index_type", mock_index_type),
            patch.object(SchemaRecord, "append_index"),
            patch("flow_sdk.fs_store.factory.type_registry.type_registry.get", return_value=FakeIndexableRecord),
        ):
            _, results1 = await SchemaRecord.rebuild_index(types=["skill"])
            _, results2 = await SchemaRecord.rebuild_index(types=["skill"])

        assert results1[0].indexed == results2[0].indexed


class TestGetIndexStatus:
    def test_never_indexed_when_no_logs(self):
        with (
            patch.object(SchemaRecord, "get_last_global_index_at", return_value=None),
            patch.object(SchemaRecord, "get_last_index_at", return_value=None),
            patch.object(SchemaRecord, "get_last_scan_at", return_value=None),
        ):
            status = SchemaRecord.get_index_status()

        assert status.never_indexed is True
        assert status.stale is False
        assert all(t.stale is True for t in status.per_type)

    def test_stale_when_old_index(self):
        old_time = "2020-01-01T00:00:00+00:00"
        with (
            patch.object(SchemaRecord, "get_last_global_index_at", return_value=old_time),
            patch.object(SchemaRecord, "get_last_index_at", return_value=old_time),
            patch.object(SchemaRecord, "get_last_scan_at", return_value=old_time),
        ):
            status = SchemaRecord.get_index_status()

        assert status.never_indexed is False
        assert status.stale is True
        assert all(t.stale is True for t in status.per_type)


class TestGetErrors:
    def test_get_errors_returns_matching_type(self, tmp_path):
        from flow_sdk.fs_records.record_error import RecordError
        from flow_sdk.fs_store.record import get_default_records_root, set_default_records_root

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        _suppress_claude_sync(tmp_path)
        try:
            rec = FakeIndexableRecord(id="rec-x")
            err = RecordError.from_exception(rec, ValueError("test"), trigger="index")
            err.save()

            # get_errors(type_name) now filters by _record_type (error subtype)
            errors = SchemaRecord.get_errors(type_name="record_error")
            assert len(errors) == 1
            assert errors[0].source_record_type == "fake_indexable"

            errors2 = SchemaRecord.get_errors(type_name="nonexistent")
            assert len(errors2) == 0
        finally:
            set_default_records_root(old_root)
