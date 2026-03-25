"""Tests for Record.unindex() and Entity.delete_by_record_ref()."""
from __future__ import annotations

from typing import ClassVar
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.fs_store.record import Record


class FakeRecord(Record):
    _record_type: ClassVar[str] = "fake_unindex"


class TestUnindex:
    @pytest.mark.asyncio
    async def test_unindex_removes_entity(self):
        rec = FakeRecord(id="test-id-1", type="fake_unindex")

        mock_entity = MagicMock()
        mock_entity.id = "test-id-1"
        mock_entity.delete = AsyncMock()

        mock_driver = MagicMock()
        mock_driver.fts_delete = AsyncMock()

        with patch(
            "flow_sdk.core.entity.entity_model.Entity.get_one",
            new_callable=AsyncMock,
            return_value=mock_entity,
        ) as mock_get_one, patch(
            "flow_sdk.db.get_db_driver",
            return_value=mock_driver,
        ):
            await rec.unindex()

        mock_get_one.assert_called_once()
        mock_entity.delete.assert_called_once()

    @pytest.mark.asyncio
    async def test_unindex_removes_fts_entry(self):
        rec = FakeRecord(id="test-id-2", type="fake_unindex")

        mock_entity = MagicMock()
        mock_entity.id = "test-id-2"
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

        mock_driver.fts_delete.assert_called_once_with("test-id-2")

    @pytest.mark.asyncio
    async def test_unindex_noop_when_no_entity(self):
        rec = FakeRecord(id="test-id-3", type="fake_unindex")

        mock_driver = MagicMock()
        mock_driver.fts_delete = AsyncMock()

        with patch(
            "flow_sdk.core.entity.entity_model.Entity.get_one",
            new_callable=AsyncMock,
            return_value=None,
        ), patch(
            "flow_sdk.db.get_db_driver",
            return_value=mock_driver,
        ):
            await rec.unindex()

        # fts_delete should not be called when no entity found
        mock_driver.fts_delete.assert_not_called()
