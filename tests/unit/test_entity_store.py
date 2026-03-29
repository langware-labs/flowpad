"""Tests for Entity._store() — sync entity metadata down to record on disk."""
from __future__ import annotations

from typing import ClassVar
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.fs_store.record import Record
from flow_sdk.fs_store.schema_registry import SchemaRegistry


class FakeStoreRecord(Record):
    _record_type: ClassVar[str] = "fake_store"


class TestEntityStore:
    @pytest.mark.asyncio
    async def test_store_writes_name_to_record(self, tmp_path):
        from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            # Create and save a record to disk
            rec = FakeStoreRecord(id="store-1", type="fake_store", name="Original")
            rec.save()

            # Create a mock Entity with updated name
            from flow_sdk.core.entity.entity_model import Entity
            entity = MagicMock(spec=Entity)
            entity.get_type.return_value = "fake_store"
            entity.id = "store-1"
            entity.name = "Updated Name"
            entity.status = None
            entity.db_json.return_value = {"name": "Updated Name"}

            with patch.object(SchemaRegistry, "get_record_cls", return_value=FakeStoreRecord):
                result = await Entity._store(entity)

            assert result is not None
            assert result.name == "Updated Name"
        finally:
            set_default_records_root(old_root)

    @pytest.mark.asyncio
    async def test_store_noop_when_no_record_class(self):
        """store() returns None when entity type has no registered Record class."""
        from flow_sdk.core.entity.entity_model import Entity

        entity = MagicMock(spec=Entity)
        entity.get_type.return_value = "unregistered_type"

        with patch.object(SchemaRegistry, "get_record_cls", return_value=None):
            result = await Entity._store(entity)
        assert result is None

    @pytest.mark.asyncio
    async def test_store_creates_record_if_missing(self, tmp_path):
        """store() creates a new record on disk when none exists yet (e.g. Bookmark, Task)."""
        from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root
        from flow_sdk.builtin.bookmark import Bookmark
        from flow_sdk.fs_records.bookmark import BookmarkRecord  # noqa: F401 — triggers SchemaRegistry registration

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            entity = Bookmark(id="bm-new-1", name="dog")

            result = await entity._store()

            assert result is not None
            assert result.id == "bm-new-1"
        finally:
            set_default_records_root(old_root)
