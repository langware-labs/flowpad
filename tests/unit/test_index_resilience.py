"""Resilience tests — cross-submodule integration tests for the Data Management System."""
from __future__ import annotations

import json
import time
from typing import ClassVar
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.fs_store.record import Record
from flow_sdk.fs_records.schema_record import SchemaRecord, ClearResult, IndexResult
from flow_sdk.fs_records.record_error import RecordError


def _suppress_claude_sync(tmp_path):
    """Prevent ClaudeErrorRecord._do_sync() from reading real debug logs."""
    claude_dir = tmp_path / "claude_error"
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / "_sync_state.json").write_text(
        json.dumps({"processed": {}, "last_sync_ts": time.time()}),
        encoding="utf-8",
    )


class FakeResilientRecord(Record):
    _record_type: ClassVar[str] = "fake_resilient"

    @property
    def content(self) -> str | None:
        return "resilient content"


class TestIndexResilience:
    @pytest.mark.asyncio
    async def test_db_deleted_and_reindexed(self):
        """Create records, index, simulate DB deletion, rebuild — records come back."""
        recs = [FakeResilientRecord(id=f"res-{i}") for i in range(3)]
        for r in recs:
            object.__setattr__(r, "sync_to_db", AsyncMock())

        mock_clear = AsyncMock(return_value=ClearResult(fts_cleared=0, entities_cleared=0, types_cleared=["fake_resilient"]))
        mock_index_type = AsyncMock(return_value=IndexResult(
            type_name="fake_resilient", indexed=3, skipped=0, duration_ms=50.0, errors=0
        ))

        with patch.object(SchemaRecord, "clear_index", mock_clear), \
             patch.object(SchemaRecord, "index_type", mock_index_type), \
             patch.object(SchemaRecord, "append_index"), \
             patch("flow_sdk.fs_store.factory.type_registry.type_registry.get", return_value=FakeResilientRecord):
            clear_result, index_results = await SchemaRecord.rebuild_index(types=["fake_resilient"])

        assert clear_result.entities_cleared == 0  # DB was "deleted" (empty)
        assert len(index_results) == 1
        assert index_results[0].indexed == 3  # All records re-indexed

    @pytest.mark.asyncio
    async def test_record_error_created_on_index_failure(self, tmp_path):
        """When index() raises, RecordError is persisted to disk."""
        from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        _suppress_claude_sync(tmp_path)
        try:
            rec = FakeResilientRecord(id="fail-res-1")

            with patch(
                "flow_sdk.fs_store.record_list.RecordList.__iter__",
                return_value=iter([rec]),
            ), patch(
                "flow_sdk.core.entity.entity_model.Entity.from_record",
                AsyncMock(side_effect=RuntimeError("DB corrupted")),
            ):
                result = await SchemaRecord.index_type(FakeResilientRecord)

            assert result.errors == 1
            assert result.skipped == 1

            # Verify RecordError was persisted (created inside rec.sync_to_db())
            errors = list(RecordError.discover())
            assert len(errors) == 1
            assert errors[0].error_message == "DB corrupted"
            assert errors[0].source_record_type == "fake_resilient"
        finally:
            set_default_records_root(old_root)

    @pytest.mark.asyncio
    async def test_record_delete_removes_file_and_db_row(self, tmp_path):
        """Full lifecycle: create + save → unindex → delete → both file and entity gone."""
        from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root
        from pathlib import Path

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            rec = FakeResilientRecord(id="del-res-1", type="fake_resilient", name="To Delete")
            rec.save()

            # Record should exist on disk
            record_dir = rec.record_dir
            assert record_dir is not None
            assert Path(record_dir).exists()

            # Mock Entity DB interactions for unindex
            mock_entity = MagicMock()
            mock_entity.id = "del-res-1"
            mock_entity.delete = AsyncMock()
            mock_driver = MagicMock()
            mock_driver.fts_delete = AsyncMock()

            with patch(
                "flow_sdk.core.entity.entity_model.Entity.get_one",
                new_callable=AsyncMock,
                return_value=mock_entity,
            ), patch(
                "flow_sdk.db.get_db_driver",
                return_value=mock_driver,
            ):
                await rec.unindex()

            # Entity should be deleted
            mock_entity.delete.assert_called_once()
            mock_driver.fts_delete.assert_called_once_with("del-res-1")

            # Delete from disk
            rec.delete()

            # Both file and entity should be gone
            assert not Path(record_dir).exists()
            assert rec.source_file is None
        finally:
            set_default_records_root(old_root)
