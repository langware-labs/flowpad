"""API integration tests for SchemaRecord discover() and incremental()."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest import mock

import pytest

from flow_sdk.fs_records.schema_record import (
    IndexRequest,
    SchemaRecord,
)
from flow_sdk.fs_records.skill_record import SkillRecord
from flow_sdk.fs_store import get_default_records_root, set_default_records_root

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path):
    """Redirect all record I/O to a temp directory for test isolation."""
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


@pytest.fixture(autouse=True)
def isolate_schema_dir(tmp_path):
    """Redirect schema log writes to tmp_path/schema."""
    schema_tmp = tmp_path / "schema"
    with mock.patch("flow_sdk.fs_store.schema_registry.SCHEMA_DIR", schema_tmp):
        yield schema_tmp


def _make_skill(name: str) -> SkillRecord:
    """Create and save a SkillRecord with the given name."""
    uid = str(uuid.uuid4())
    rec = SkillRecord(id=uid, name=name, description=f"{name} description")
    rec.save()
    return rec


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_discover_specific_types(isolate_records_root, isolate_schema_dir):
    _make_skill("gamma")

    scan_results, index_results = await SchemaRecord.discover(types=["skill"])

    assert len(scan_results) == 1
    assert scan_results[0].type_name == "skill"
    assert len(index_results) == 1
    assert index_results[0].type_name == "skill"

    print(f"[stats] discover(skill only): count={scan_results[0].count}, indexed={index_results[0].indexed}")


@pytest.mark.asyncio
async def test_discover_actions_scan_only(isolate_records_root, isolate_schema_dir):
    _make_skill("scan-only")

    scan_results, index_results = await SchemaRecord.discover(types=["skill"], actions=["scan"])

    assert len(scan_results) == 1
    assert scan_results[0].count >= 1
    assert len(index_results) == 0

    # Per-type scan log should be written
    assert (isolate_schema_dir / "types" / "skill" / "scan_log.jsonl").exists()
    # No index log for skill
    assert not (isolate_schema_dir / "types" / "skill" / "index_log.jsonl").exists()

    print(f"[stats] scan-only: count={scan_results[0].count}")


@pytest.mark.asyncio
async def test_discover_actions_index_only(isolate_records_root, isolate_schema_dir):
    _make_skill("index-only")

    scan_results, index_results = await SchemaRecord.discover(types=["skill"], actions=["index"])

    assert len(scan_results) == 0
    assert len(index_results) == 1
    assert index_results[0].indexed >= 1

    # Per-type index log should be written
    assert (isolate_schema_dir / "types" / "skill" / "index_log.jsonl").exists()
    # No scan log for skill
    assert not (isolate_schema_dir / "types" / "skill" / "scan_log.jsonl").exists()

    print(f"[stats] index-only: indexed={index_results[0].indexed}")


@pytest.mark.asyncio
async def test_incremental_skips_recent(isolate_records_root, isolate_schema_dir):
    _make_skill("fresh-skill")

    # Record start_time BEFORE discover so last_at (written by discover) >= start_time
    start = datetime.now(timezone.utc)
    await SchemaRecord.discover(types=["skill"])

    # Incremental: skill was just indexed after start_time → should be skipped
    _, index_results = await SchemaRecord.incremental(IndexRequest(types=["skill"], start_time=start))

    # All types skipped (last_index_at >= start_time)
    assert len(index_results) == 0

    print("[stats] incremental_skips_recent: index_results=0 (all fresh)")


@pytest.mark.asyncio
async def test_incremental_includes_stale(isolate_records_root, isolate_schema_dir):
    _make_skill("stale-skill")

    # Very old start_time — nothing was indexed since 2000, so all types should run
    old_time = datetime(2000, 1, 1, tzinfo=timezone.utc)
    _, index_results = await SchemaRecord.incremental(IndexRequest(types=["skill"], start_time=old_time))

    assert len(index_results) >= 1
    skill_result = next((r for r in index_results if r.type_name == "skill"), None)
    assert skill_result is not None
    # With skip_fresh, real skills with sync markers are counted as fresh not indexed.
    # Assert that at least some records were processed (indexed or skipped as fresh).
    assert (skill_result.indexed + skill_result.fresh) >= 1

    print(f"[stats] incremental_includes_stale: indexed={skill_result.indexed}, fresh={skill_result.fresh}")


@pytest.mark.asyncio
async def test_incremental_partial(isolate_records_root, isolate_schema_dir):
    """Mix of fresh and stale types — only stale ones appear in results."""
    _make_skill("partial-skill")

    # Record start_time BEFORE discover so last_at (written by discover) >= start_time
    start = datetime.now(timezone.utc)
    await SchemaRecord.discover(types=["skill"])

    # Now incremental: skill was indexed after start_time → skip. bookmark has no index → run.
    _, index_results = await SchemaRecord.incremental(IndexRequest(types=["skill", "bookmark"], start_time=start))

    # skill should be skipped (just indexed), bookmark may or may not be indexed
    type_names = [r.type_name for r in index_results]
    assert "skill" not in type_names, f"skill should have been skipped but got: {type_names}"

    print(f"[stats] incremental_partial: processed types={type_names}")


@pytest.mark.asyncio
async def test_log_files_created(isolate_records_root, isolate_schema_dir):
    _make_skill("log-test")

    await SchemaRecord.discover(types=["skill"])

    assert (isolate_schema_dir / "scan_log.jsonl").exists()
    assert (isolate_schema_dir / "index_log.jsonl").exists()
    assert (isolate_schema_dir / "types" / "skill" / "scan_log.jsonl").exists()
    assert (isolate_schema_dir / "types" / "skill" / "index_log.jsonl").exists()

    print("[stats] log_files_created: all expected log files present")


@pytest.mark.asyncio
async def test_discover_returns_scan_and_index_results(isolate_records_root, isolate_schema_dir):
    _make_skill("result-check")

    scan_results, index_results = await SchemaRecord.discover(types=["skill"])

    assert len(scan_results) >= 1
    assert len(index_results) >= 1

    for sr in scan_results:
        assert isinstance(sr.count, int)
        assert isinstance(sr.total_bytes, int)
        assert isinstance(sr.scan_ms, float)
        assert sr.last_scan_at is not None

    for ir in index_results:
        assert isinstance(ir.indexed, int)
        assert isinstance(ir.skipped, int)
        assert isinstance(ir.duration_ms, float)
        assert ir.last_index_at is not None

    print(
        f"[stats] result fields: scan_ms={scan_results[0].scan_ms}, "
        f"indexed={index_results[0].indexed}, index_ms={index_results[0].duration_ms}"
    )
