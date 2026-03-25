"""Tests for index-required-staleness (Sub 6).

Tests index_required property and skip_fresh behavior in index_type.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import ClassVar
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.fs_store.record import Record, set_default_records_root, get_default_records_root


class SampleRecord(Record):
    _record_type: ClassVar[str] = "sample_staleness"

    @property
    def content(self) -> str | None:
        return getattr(self, "description", None)


@pytest.fixture
def tmp_record(tmp_path):
    old_root = get_default_records_root()
    set_default_records_root(tmp_path)
    rec = SampleRecord(type="sample_staleness", id="stale-001", name="Test", description="Hello")
    rec.path = str(tmp_path / "sample_staleness" / "sample_staleness-@stale-001")
    rec.save()
    yield rec, tmp_path
    set_default_records_root(old_root)


class TestRequiresIndex:
    def test_no_marker_requires_index(self, tmp_record):
        """A record with no sync marker requires indexing."""
        rec, tmp_path = tmp_record
        # Remove any sync markers
        rd = Path(rec.path)
        for f in rd.glob("*.hash"):
            f.unlink(missing_ok=True)
        for f in rd.glob("*.hash"):
            f.unlink()
        assert rec.index_required is True

    def test_fresh_marker_does_not_require_index(self, tmp_record):
        """A record with matching fingerprint does not require indexing."""
        rec, _ = tmp_record
        rec.write_hash_file(rec.fingerprint)
        assert rec.index_required is False

    def test_stale_fingerprint_does_not_require_index(self, tmp_record):
        """A record with a stale fingerprint hash file still has a sentinel present.

        index_required only checks for presence of the sentinel file (not staleness).
        Staleness checking is handled separately by record_update_required().
        """
        rec, _ = tmp_record
        rec.write_hash_file("old_stale_fp_value")
        # Sentinel file exists → index_required is False regardless of staleness
        assert rec.index_required is False


class TestIndexTypeSkipFresh:
    @pytest.mark.asyncio
    async def test_skip_fresh_skips_indexed_records(self, tmp_path):
        """index_type with skip_fresh=True skips records with fresh markers."""
        from flow_sdk.fs_store.schema_registry import SchemaRegistry, IndexResult

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            # Create a record and mark it fresh
            rec = SampleRecord(type="sample_staleness", id="fresh-001", name="Fresh")
            rec.path = str(tmp_path / "sample_staleness" / "sample_staleness-@fresh-001")
            rec.save()
            rec.write_hash_file(rec.fingerprint)

            # Register the type
            with patch.object(SchemaRegistry, "get", return_value=type("Info", (), {"record_cls": SampleRecord})()):
                with patch("flow_sdk.fs_store.record.Record.sync_to_db", new_callable=AsyncMock):
                    result = await SchemaRegistry.index_type("sample_staleness", skip_fresh=True)
                    assert result.fresh >= 1
                    assert result.indexed == 0
        finally:
            set_default_records_root(old_root)

    @pytest.mark.asyncio
    async def test_skip_fresh_false_indexes_all(self, tmp_path):
        """index_type with skip_fresh=False indexes all records regardless of marker."""
        from flow_sdk.fs_store.schema_registry import SchemaRegistry

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            rec = SampleRecord(type="sample_staleness", id="all-001", name="All")
            rec.path = str(tmp_path / "sample_staleness" / "sample_staleness-@all-001")
            rec.save()
            rec.write_hash_file(rec.fingerprint)

            with patch.object(SchemaRegistry, "get", return_value=type("Info", (), {"record_cls": SampleRecord})()):
                with patch("flow_sdk.fs_store.record.Record.sync_to_db", new_callable=AsyncMock):
                    result = await SchemaRegistry.index_type("sample_staleness", skip_fresh=False)
                    assert result.fresh == 0
                    assert result.indexed >= 1
        finally:
            set_default_records_root(old_root)

    @pytest.mark.asyncio
    async def test_fresh_count_in_result(self, tmp_path):
        """IndexResult.fresh counts records skipped because they were fresh."""
        from flow_sdk.fs_store.schema_registry import IndexResult

        result = IndexResult(
            type_name="test",
            indexed=5,
            skipped=3,
            duration_ms=100.0,
            fresh=2,
        )
        assert result.fresh == 2
        assert result.indexed == 5
        assert result.skipped == 3


class TestIncrementalUsesSkipFresh:

    @pytest.mark.asyncio
    async def test_incremental_passes_skip_fresh(self):
        """incremental() passes skip_fresh=True to index_type."""
        from flow_sdk.fs_store.schema_registry import (
            SchemaRegistry, IndexRequest, IndexResult, ScanResult,
        )

        with patch.object(SchemaRegistry, "index_type", new_callable=AsyncMock) as mock_it, \
             patch.object(SchemaRegistry, "_scan_type") as mock_scan, \
             patch.object(SchemaRegistry, "get_record_cls", return_value=SampleRecord), \
             patch.object(SchemaRegistry, "get_default_index_types", return_value=["sample_staleness"]), \
             patch.object(SchemaRegistry, "get_last_index_at", return_value=None), \
             patch.object(SchemaRegistry, "get_last_scan_at", return_value=None), \
             patch.object(SchemaRegistry, "append_scan", return_value="2026-01-01T00:00:00"), \
             patch.object(SchemaRegistry, "append_index", return_value="2026-01-01T00:00:00"):

            mock_scan.return_value = ScanResult(type_name="sample_staleness", count=1, total_bytes=100, scan_ms=1.0)
            mock_it.return_value = IndexResult(type_name="sample_staleness", indexed=1, skipped=0, duration_ms=1.0)

            req = IndexRequest(
                types=["sample_staleness"],
                trigger="incremental",
                actions=["scan", "index"],
            )
            await SchemaRegistry.incremental(req)

            mock_it.assert_awaited_once()
            _, kwargs = mock_it.call_args
            assert kwargs.get("skip_fresh") is True
