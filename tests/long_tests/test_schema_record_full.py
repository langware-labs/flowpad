"""Long tests for SchemaRecord — real filesystem, all default types.

These tests are slow (can take 60-300s on large machines) and are gated by:
  pytest -m slow  or  python -m pytest tests/long_tests/ -v -s

Each test prints a stats table so the operator can evaluate performance.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

from flow_sdk.fs_records.schema_record import IndexRequest, SchemaRecord


@pytest.mark.timeout(300)
@pytest.mark.asyncio
async def test_full_discover_all_default_types():
    """Run SchemaRecord.discover() on the real ~/.flow/records/ and print stats."""
    scan_results, index_results = await SchemaRecord.discover(trigger="long-test")

    # Build a lookup by type_name
    index_by_type = {r.type_name: r for r in index_results}

    print("\n")
    print(f"{'type':<25} {'count':>8} {'bytes':>12} {'scan_ms':>10} {'indexed':>8} {'index_ms':>10}")
    print("-" * 80)

    total_count = 0
    total_bytes = 0
    total_scan_ms = 0.0
    total_indexed = 0
    total_index_ms = 0.0

    for sr in scan_results:
        ir = index_by_type.get(sr.type_name)
        indexed = ir.indexed if ir else 0
        index_ms = ir.duration_ms if ir else 0.0
        print(f"{sr.type_name:<25} {sr.count:>8} {sr.total_bytes:>12,} {sr.scan_ms:>10.1f} "
              f"{indexed:>8} {index_ms:>10.1f}")
        total_count += sr.count
        total_bytes += sr.total_bytes
        total_scan_ms += sr.scan_ms
        total_indexed += indexed
        total_index_ms += index_ms

    print("-" * 80)
    print(f"{'TOTAL':<25} {total_count:>8} {total_bytes:>12,} {total_scan_ms:>10.1f} "
          f"{total_indexed:>8} {total_index_ms:>10.1f}")

    assert isinstance(scan_results, list)
    assert isinstance(index_results, list)


@pytest.mark.timeout(300)
@pytest.mark.asyncio
async def test_incremental_after_full():
    """Full discover, then incremental with start_time just before → expect 0 indexed."""
    # Capture start BEFORE the full pass so that all per-type index
    # timestamps are >= start, causing incremental to skip them.
    start = datetime.now(timezone.utc)

    # First full pass
    await SchemaRecord.discover(trigger="long-test-pre")

    _, index_results = await SchemaRecord.incremental(
        IndexRequest(start_time=start, trigger="long-test-incremental")
    )

    print(f"\n[stats] incremental after full: {len(index_results)} types re-indexed (expected 0)")
    assert len(index_results) == 0, (
        f"Expected 0 types re-indexed after fresh discover, got {len(index_results)}: "
        f"{[r.type_name for r in index_results]}"
    )


@pytest.mark.timeout(300)
@pytest.mark.asyncio
async def test_discover_with_limit_per_type():
    """discover(limit_per_type=5) — each IndexResult.indexed should be <= 5."""
    limit = 5
    scan_results, index_results = await SchemaRecord.discover(
        trigger="long-test-limited",
        limit_per_type=limit,
    )

    print(f"\n{'type':<25} {'count':>8} {'indexed':>8}")
    print("-" * 45)
    for sr in scan_results:
        ir = next((r for r in index_results if r.type_name == sr.type_name), None)
        indexed = ir.indexed if ir else 0
        print(f"{sr.type_name:<25} {sr.count:>8} {indexed:>8}")

    for ir in index_results:
        assert ir.indexed <= limit, (
            f"type={ir.type_name}: indexed={ir.indexed} exceeded limit={limit}"
        )
