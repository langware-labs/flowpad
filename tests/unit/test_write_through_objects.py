"""Tests for write-through-objects (Sub 7).

Verifies that sync_from_entity and Entity._store() update the sync marker,
making index_required return False after a write-through.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import ClassVar
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.fs_store.record import Record, set_default_records_root, get_default_records_root


class SampleRecord(Record):
    _record_type: ClassVar[str] = "wt_sample"

    @property
    def content(self) -> str | None:
        return getattr(self, "description", None)


@pytest.fixture
def tmp_record(tmp_path):
    old_root = get_default_records_root()
    set_default_records_root(tmp_path)
    rec = SampleRecord(type="wt_sample", id="wt-001", name="Test", description="Hello")
    rec.path = str(tmp_path / "wt_sample" / "wt_sample-@wt-001")
    rec.save()
    yield rec, tmp_path
    set_default_records_root(old_root)


class TestWriteThrough:
    def test_sync_from_entity_updates_sync_marker(self, tmp_record):
        """sync_from_entity writes a sync marker after saving."""
        rec, _ = tmp_record
        # Remove any existing markers
        rd = Path(rec.path)
        for f in rd.glob("*.hash"):
            f.unlink(missing_ok=True)
        for f in rd.glob("*.hash"):
            f.unlink()
        assert rec.index_required is True

        # Create a mock entity with db_json
        entity = MagicMock()
        entity.db_json.return_value = {"name": "Updated", "status": "active"}

        rec.sync_from_entity(entity)

        # Now the record should have a sync marker and not require indexing
        assert rec.index_required is False
        hash_files = list(rd.glob("*.hash"))
        assert len(hash_files) == 1

    def test_sync_from_entity_makes_index_required_false(self, tmp_record):
        """After sync_from_entity, index_required returns False."""
        rec, _ = tmp_record
        entity = MagicMock()
        entity.db_json.return_value = {"name": "Fresh"}

        rec.sync_from_entity(entity)
        assert rec.index_required is False

    @pytest.mark.asyncio
    async def test_entity_store_updates_sync_marker(self, tmp_path):
        """Entity._store() writes sync marker after record.save()."""
        from flow_sdk.core.entity.entity_model import Entity

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            rec = SampleRecord(type="wt_sample", id="store-001", name="StoreTest")
            rec.path = str(tmp_path / "wt_sample" / "wt_sample-@store-001")
            rec.save()

            # Remove any existing hash files
            rd = Path(rec.path)
            for f in rd.glob("*.hash"):
                f.unlink(missing_ok=True)

            entity = MagicMock(spec=Entity)
            entity.get_type.return_value = "wt_sample"
            entity.id = "store-001"
            entity.name = "Updated"
            entity.status = "active"
            entity.db_json.return_value = {"name": "Updated", "status": "active"}

            from flow_sdk.fs_store.schema_registry import SchemaRegistry
            with (
                patch.object(SchemaRegistry, "get_record_cls", return_value=SampleRecord),
                patch.object(SampleRecord, "discover_one", return_value=rec),
            ):
                # Call the real store method
                result = await Entity._store(entity)
            assert result is not None
            # Hash sentinel should be written
            hash_files = list(rd.glob("*.hash"))
            assert len(hash_files) == 1
        finally:
            set_default_records_root(old_root)

    def test_write_through_failure_is_non_fatal(self, tmp_record):
        """sync_from_entity on read-only record returns False without error."""
        from flow_sdk.fs_store.fs_ref import FSRef
        rec, _ = tmp_record
        object.__setattr__(rec, "_asset_ref", FSRef("/", read_only=True))
        entity = MagicMock()
        entity.db_json.return_value = {"name": "Fail"}
        result = rec.sync_from_entity(entity)
        assert result is False

    def test_sync_from_entity_updates_data(self, tmp_record):
        """sync_from_entity merges entity fields into record _data."""
        rec, _ = tmp_record
        entity = MagicMock()
        entity.db_json.return_value = {"name": "NewName", "status": "completed"}

        rec.sync_from_entity(entity)
        assert rec.data["name"] == "NewName"
        assert rec.data["status"] == "completed"

    def test_entity_save_calls_store(self):
        """Entity.save() calls _store() so every save syncs to disk record."""
        import inspect
        from flow_sdk.core.entity import entity_model
        source = inspect.getsource(entity_model.Entity.save)
        assert "await self._store()" in source

    def test_graph_crud_does_not_call_store_directly(self):
        """graph_crud_actions no longer calls _store() directly — Entity.save() handles it."""
        import inspect
        from flow_sdk.app.actions import graph_crud_actions
        source = inspect.getsource(graph_crud_actions)
        assert "entity._store()" not in source
        assert "entity.store()" not in source
        assert "record.sync_from_entity(entity)" not in source
