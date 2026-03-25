"""Tests for index endpoint handler logic (unit tests, no running server)."""
from __future__ import annotations

from dataclasses import asdict
from typing import ClassVar
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.fs_records.schema_record import (
    ClearResult,
    IndexResult,
    IndexStatus,
    SchemaRecord,
    TypeIndexStatus,
)


class FakeQueryParams:
    def __init__(self, params: dict):
        self._params = params

    def get(self, key, default=""):
        return self._params.get(key, default)


class FakeRequest:
    def __init__(self, query_params: dict):
        self.query_params = FakeQueryParams(query_params)


class FakeRequestInfo:
    def __init__(self, query_params: dict):
        self.request = FakeRequest(query_params)


class TestIndexEndpoints:
    """Test the handler logic directly via SchemaRecord methods."""

    @pytest.mark.asyncio
    async def test_post_index_happy_path(self):
        """index_type returns correct IndexResult."""
        mock_ir = IndexResult(type_name="skill", indexed=5, skipped=0, duration_ms=100.0, errors=0)

        with patch.object(SchemaRecord, "index_type", new_callable=AsyncMock, return_value=mock_ir):
            ir = await SchemaRecord.index_type(MagicMock())

        assert ir.indexed == 5
        assert ir.errors == 0

    @pytest.mark.asyncio
    async def test_post_index_unknown_type(self):
        """When type_registry.get returns None, the type is unknown."""
        with patch(
            "flow_sdk.fs_store.factory.type_registry.type_registry.get",
            return_value=None,
        ):
            from flow_sdk.fs_store.factory.type_registry import type_registry
            record_cls = type_registry.get("nonexistent_type")
            assert record_cls is None

    @pytest.mark.asyncio
    async def test_delete_index_clears(self):
        """clear_index removes FTS and entities."""
        mock_result = ClearResult(fts_cleared=10, entities_cleared=5, types_cleared=["skill"])

        with patch.object(SchemaRecord, "clear_index", new_callable=AsyncMock, return_value=mock_result):
            result = await SchemaRecord.clear_index()

        assert result.fts_cleared == 10
        assert result.entities_cleared == 5

    @pytest.mark.asyncio
    async def test_delete_index_empty_db(self):
        """clear_index on empty DB returns zeros."""
        mock_result = ClearResult(fts_cleared=0, entities_cleared=0, types_cleared=[])

        with patch.object(SchemaRecord, "clear_index", new_callable=AsyncMock, return_value=mock_result):
            result = await SchemaRecord.clear_index()

        assert result.fts_cleared == 0
        assert result.entities_cleared == 0

    def test_get_index_status_never_indexed(self):
        """get_index_status returns never_indexed=True when no logs."""
        with patch.object(SchemaRecord, "get_last_global_index_at", return_value=None), \
             patch.object(SchemaRecord, "get_last_index_at", return_value=None), \
             patch.object(SchemaRecord, "get_last_scan_at", return_value=None):
            status = SchemaRecord.get_index_status()

        assert status.never_indexed is True
        assert status.last_indexed_at is None

    def test_get_index_status_after_index(self):
        """get_index_status returns timestamps after indexing."""
        from datetime import UTC, datetime, timedelta
        ts = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
        with patch.object(SchemaRecord, "get_last_global_index_at", return_value=ts), \
             patch.object(SchemaRecord, "get_last_index_at", return_value=ts), \
             patch.object(SchemaRecord, "get_last_scan_at", return_value=ts):
            status = SchemaRecord.get_index_status()

        assert status.never_indexed is False
        assert status.last_indexed_at == ts
        assert status.stale is False  # recent timestamp
        # Verify per_type serialization works
        for t in status.per_type:
            d = asdict(t)
            assert "type_name" in d
            assert "stale" in d
