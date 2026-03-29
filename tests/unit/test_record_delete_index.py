"""Tests for record delete with index cleanup."""
from __future__ import annotations

from typing import ClassVar
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.fs_store.record import Record


class FakeDeleteRecord(Record):
    _record_type: ClassVar[str] = "fake_delete"


class TestDeleteWithIndex:
    @pytest.mark.asyncio
    async def test_delete_removes_file_and_db_row(self, tmp_path):
        """delete() removes disk, Entity DB row, and FTS in one call."""
        from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            rec = FakeDeleteRecord(id="del-1", type="fake_delete", name="To Delete")
            rec.save()
            assert rec.source_file is not None or rec.path is not None

            mock_entity = MagicMock()
            mock_entity.id = "del-1"
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
                await rec.delete()

            mock_entity.delete.assert_called_once()
            mock_driver.fts_delete.assert_called_once_with("del-1")
            assert rec.source_file is None
            assert rec.path is None
        finally:
            set_default_records_root(old_root)

    @pytest.mark.asyncio
    async def test_delete_removes_file_only(self, tmp_path):
        """When no entity exists, unindex is a no-op, delete still removes file."""
        from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            rec = FakeDeleteRecord(id="del-2", type="fake_delete")
            rec.save()

            with patch(
                "flow_sdk.core.entity.entity_model.Entity.get_one",
                new_callable=AsyncMock,
                return_value=None,
            ), patch(
                "flow_sdk.db.get_db_driver",
                return_value=MagicMock(),
            ):
                await rec.delete()

            assert rec.source_file is None
        finally:
            set_default_records_root(old_root)

    @pytest.mark.asyncio
    async def test_delete_removes_folder_layout(self, tmp_path):
        """Folder-layout record gets its directory removed by delete()."""
        from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root
        from pathlib import Path

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            rec = FakeDeleteRecord(id="del-3", type="fake_delete")
            rec.save()
            record_dir = rec.record_dir
            assert record_dir is not None
            assert Path(record_dir).exists()

            await rec.delete()
            assert not Path(record_dir).exists()
        finally:
            set_default_records_root(old_root)
