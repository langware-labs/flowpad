"""Integration tests for `_handle_fs_records_index` — the HTTP index endpoint.

Verifies DB writes, rebuild semantics (clear + reindex), single-type filter,
and progress event emission.
"""

from __future__ import annotations

from typing import Any

import pytest

from flow_sdk.builtin.faas.fs_records_actions import FsRecordsActionsMixin
from flow_sdk.builtin.faas.in_process_activity import InProcessActivity
from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.indexer import reset_shared_indexer
from flow_sdk.fs_store.record_types import RecordType


class FakeQueryParams:
    def __init__(self, params: dict):
        self._p = params

    def get(self, key, default=None):
        """Mirror Starlette's QueryParams.get — absent key yields ``default``,
        which is ``None`` unless the caller asks otherwise.

        This default is load-bearing, not cosmetic. `_handle_fs_records_index`
        branches on ``qp.get("user") is not None``; with a ``""`` default every
        request looked like it carried an explicit scope, so the whole fake
        suite took the `resolve_project_scope` branch and NEVER exercised the
        `get_all_scope_filter(create_missing=True)` path the real endpoint uses.
        """
        return self._p.get(key, default)


class FakeRequest:
    def __init__(self, params: dict):
        self.query_params = FakeQueryParams(params)


class FakeRequestInfo:
    def __init__(self, params: dict):
        self.request = FakeRequest(params)


class _Handler(FsRecordsActionsMixin):
    def __init__(self):
        self.typeid = "test-compute-node"
        self._activity: InProcessActivity | None = None

    def _start_activity(self, job_name: str, timeout_seconds: int = 600):
        self._activity = InProcessActivity(
            job_name=job_name, entity_id=self.typeid,
            timeout_seconds=timeout_seconds,
        )
        return self._activity

    def _complete_activity(self, job_name: str) -> None:
        self._activity = None


@pytest.fixture(autouse=True)
def _reset_indexer():
    reset_shared_indexer()
    yield
    reset_shared_indexer()


@pytest.fixture
def captured_progress(monkeypatch):
    events: list[dict] = []

    async def fake(to_entity: str, flow_data: Any) -> None:
        events.append(flow_data)

    monkeypatch.setattr(
        "flow_sdk.core.network.resource_tracker.broadcast_progress", fake,
    )
    return events


@pytest.fixture
async def clean_target_types():
    """Clear the test DB for types this test writes. Run before AND after each test."""
    driver = get_db_driver()
    targets = [
        RecordType.CLAUDE_SESSION, RecordType.PROJECT, RecordType.PLAN,
        RecordType.MARKDOWN, RecordType.CLAUDE_MD, RecordType.CLAUDE_RULES,
        RecordType.SKILL, RecordType.SUBAGENT,
        RecordType.COMMAND, RecordType.CLAUDE_MEMORY, RecordType.SPEC,
        RecordType.CLAUDE_HOOK, RecordType.TASK,
    ]
    for t in targets:
        await driver.delete_entities_by_type(str(t))
    await driver.fts_clear()
    yield driver
    for t in targets:
        await driver.delete_entities_by_type(str(t))
    await driver.fts_clear()


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_index_handler_single_type_writes_to_db(
    captured_progress, clean_target_types, tmp_path,
):
    """?type=claude_session → only CLAUDE_SESSION rows written."""
    # Give discovery one real registered cwd, the way every real machine has
    # them: a ~/.claude/projects/<encoded>/ dir whose session JSONL carries the
    # authoritative `cwd`. Without this the sandbox registry is empty, nothing
    # is discoverable, and the scope phase has no work — which is why the
    # side-effect assertion below cannot fire on an empty sandbox.
    import json as _json
    import pathlib

    from flow_sdk.instance_settings import get_instance_settings

    # NOT tmp_path: pytest's tmp_path lives under /var/folders, which
    # `is_valid_project_cwd` correctly rejects as a temp path, so a tmp cwd is
    # never discoverable. Use the repo checkout — a real, non-temp directory
    # that exists. Nothing is written to it; only its path is registered.
    known_cwd = pathlib.Path(__file__).resolve().parents[3]
    projects_dir = get_instance_settings().claude_projects_dir
    entry = projects_dir / "-known-cwd"
    entry.mkdir(parents=True, exist_ok=True)
    (entry / "session.jsonl").write_text(
        _json.dumps({"cwd": str(known_cwd)}) + "\n", encoding="utf-8"
    )

    h = _Handler()
    resp = await h._handle_fs_records_index(
        FakeRequestInfo({"type": str(RecordType.CLAUDE_SESSION)})
    )

    from flow_sdk.responses.response import ApiSuccessResponse
    assert isinstance(resp, ApiSuccessResponse)
    assert resp.data["type"] == "claude_session"
    assert resp.data["indexed"] >= 0

    count = await clean_target_types.count_entities_by_type(
        str(RecordType.CLAUDE_SESSION)
    )
    # The test instance sandbox (claude_home) is empty so indexed/count may
    # both be zero. Just check the response shape is consistent: indexed
    # counts refs processed, count is unique DB rows, and indexed must be
    # >= count (UPSERTs on branched sessionIds keep indexed ahead of count).
    assert resp.data["indexed"] >= count, (
        f"indexed ({resp.data['indexed']}) must be >= count ({count})"
    )

    # An index of ONE type must not mint projects as a side effect.
    # `_handle_fs_records_index` resolves its scope via
    # `get_all_scope_filter(create_missing=True)` BEFORE it takes the index
    # single-flight guard, so every discovered cwd without a row is
    # materialized (project + its wiki child) on what is a read path.
    # Measured on the endpoint: 38.854s in that phase on a cold DB vs 1.4s
    # warm, while the index job itself is 2.4s — and a second request that
    # arrives during it gets `409 Job 'index' already running`.
    projects = await clean_target_types.count_entities_by_type(str(RecordType.PROJECT))
    assert projects == 0, (
        f"indexing ?type=claude_session minted {projects} project rows; "
        "scope resolution must not create entities on the index read path"
    )


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_index_handler_unknown_type_400(captured_progress):
    h = _Handler()
    resp = await h._handle_fs_records_index(
        FakeRequestInfo({"type": "no_such_type_xyz"})
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_direct_file_skips_global_scope_and_preserves_known_project(
    clean_target_types, monkeypatch, tmp_path,
):
    from flow_sdk.builtin.claude_memory_entities import Markdown
    from flow_sdk.builtin.project import Project
    from flow_sdk.responses.response import ApiSuccessResponse

    project_root = tmp_path / "known-project"
    project_root.mkdir()
    project = Project(
        id=Project.derive_id_for_path(project_root),
        name="known-project",
        fs_storage_mount_path=str(project_root),
    )
    await project.save()
    path = project_root / "direct.md"
    path.write_text("# direct\n", encoding="utf-8")

    async def forbidden(*args, **kwargs):
        pytest.fail("direct-file branch invoked global scope/root resolution")

    monkeypatch.setattr(
        "flow_sdk.fs_store.operations.all_projects.get_all_scope_filter", forbidden,
    )
    monkeypatch.setattr(
        "flow_sdk.server.search_filters.resolve_project_scope", forbidden,
    )
    monkeypatch.setattr("flow_sdk.fs_store.indexer.get_shared_indexer", forbidden)
    handler = _Handler()
    monkeypatch.setattr(handler, "_resolve_scoped_roots", forbidden)

    resp = await handler._handle_fs_records_index(
        FakeRequestInfo({"type": "markdown", "path": str(path)})
    )

    assert isinstance(resp, ApiSuccessResponse)
    entity_id = resp.data["typeid"].removeprefix("markdown-")
    # This branch parses and syncs the file, so it must report a real duration.
    # The expected payload below used to pin `duration_ms: 0.0`, locking in a
    # hardcoded placeholder — a single-file index advertised itself as free.
    direct_ms = resp.data["types"][0]["duration_ms"]
    assert direct_ms > 0.0, f"direct-file index reported duration_ms={direct_ms}"
    assert resp.data == {
        "type": "markdown",
        "indexed": 1,
        "errors": 0,
        "orphans_found": 0,
        "orphans_db_removed": 0,
        "orphans_disk_removed": 0,
        "typeid": f"markdown-{entity_id}",
        "typeids": [f"markdown-{entity_id}"],
        "types": [{
            "type": "markdown",
            "indexed": 1,
            "new": 1,
            "skipped": 0,
            "errors": 0,
            "duration_ms": direct_ms,
            "orphans_found": 0,
            "orphans_db_removed": 0,
            "orphans_disk_removed": 0,
        }],
        "total_indexed": 1,
        "total_errors": 0,
    }
    stored = await Markdown.get_by_id(entity_id)
    assert stored is not None
    assert stored.project_id == project.id


@pytest.mark.asyncio
async def test_direct_file_still_validates_orphan_action_before_shortcut(
    monkeypatch, tmp_path,
):
    path = tmp_path / "direct.md"
    path.write_text("# direct\n", encoding="utf-8")

    async def forbidden(*args, **kwargs):
        pytest.fail("invalid direct-file request invoked global scope resolution")

    monkeypatch.setattr(
        "flow_sdk.fs_store.operations.all_projects.get_all_scope_filter", forbidden,
    )
    resp = await _Handler()._handle_fs_records_index(FakeRequestInfo({
        "type": "markdown",
        "path": str(path),
        "orphan_action": "not-valid",
    }))

    assert resp.status_code == 400
    assert "Invalid orphan_action" in resp.message


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_index_handler_rebuild_clears_first(
    captured_progress, clean_target_types,
):
    """?rebuild=true with ?type=X → type is cleared, then re-indexed."""
    h = _Handler()
    # First pass: index CLAUDE_RULES (may be empty on this machine; any count)
    await h._handle_fs_records_index(
        FakeRequestInfo({"type": str(RecordType.CLAUDE_RULES)})
    )
    before = await clean_target_types.count_entities_by_type(
        str(RecordType.CLAUDE_RULES)
    )

    # Rebuild — should clear and re-index to the same count
    resp = await h._handle_fs_records_index(
        FakeRequestInfo({"type": str(RecordType.CLAUDE_RULES), "rebuild": "true"})
    )
    from flow_sdk.responses.response import ApiSuccessResponse
    assert isinstance(resp, ApiSuccessResponse)

    after = await clean_target_types.count_entities_by_type(
        str(RecordType.CLAUDE_RULES)
    )
    # Rebuild preserves content (same source files, same records)
    assert after == before


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_index_handler_emits_table_snapshots(
    captured_progress, clean_target_types,
):
    """Index emits at least the initial + terminal IndexProgressTable snapshots."""
    h = _Handler()
    await h._handle_fs_records_index(
        FakeRequestInfo({"type": str(RecordType.CLAUDE_RULES)})
    )

    snapshots = [
        ev["attributes"] for ev in captured_progress
        if ev.get("element_type") == "progress_report"
        and ev.get("attributes", {}).get("job_name") == "index"
    ]
    assert len(snapshots) >= 2, (
        f"expected ≥2 snapshots (initial + terminal), got {len(snapshots)}"
    )

    for s in snapshots:
        assert isinstance(s.get("rows"), list)
        assert isinstance(s.get("done"), int)
        assert isinstance(s.get("total"), int)
        for row in s["rows"]:
            assert row["done"] <= row["total"]

    final = snapshots[-1]
    assert final["text"] == "complete"
    assert final["current"] is None


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_index_status_reports_a_type_with_pending_changes_as_stale(
    clean_target_types, tmp_path,
):
    """`stale` must mean "changes pending next index" — the endpoint's own contract.

    Regression: `index_log.get_index_status` hardcodes `stale=False` on
    every per-type row (schema_registry.py:1279) and on the unscoped rollup
    (:1301), so the freshness signal is a constant. Only the single-project
    branch (:1292) computes it, from the project record's `index_required`.
    Measured on a live backend: `stale: False` for all 33 types while a full
    index was re-parsing 5,428 records every run, and `total_orphans: 0` while
    a scan of the same instance reported 778 orphans.
    """
    import os
    import time as _time

    from flow_sdk.fs_store.fs_record import FSRecord
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
    from flow_sdk.fs_store.indexer.functions.markdown import markdown_flat_fn

    root = tmp_path / "proj"
    (root / "docs").mkdir(parents=True)
    doc = root / "docs" / "a.md"
    doc.write_text("# a\n", encoding="utf-8")

    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER))
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)
    r1 = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    assert r1.per_type[RecordType.MARKDOWN].indexed == 1

    # Make it GENUINELY stale — real edit, real mtime bump.
    new_ts = _time.time() + 2
    doc.write_text("# a changed\n", encoding="utf-8")
    os.utime(doc, (new_ts, new_ts))

    # Ground truth (precondition, not the assertion): the REAL row id, read
    # back from the DB, must report index_required — i.e. changes are pending.
    rows = await clean_target_types.list_entity_sources_by_type(str(RecordType.MARKDOWN))
    assert len(rows) == 1, f"expected exactly one markdown row, got {len(rows)}"
    row_id = next(iter(rows))
    probe = FSRecord(type=str(RecordType.MARKDOWN), id=row_id, asset_ref=FSRef(doc))
    assert probe.index_required is True, (
        "precondition: the edited file must read as index_required"
    )

    h = _Handler()
    resp = await h._handle_fs_records_index_status(FakeRequestInfo({}))
    from flow_sdk.responses.response import ApiSuccessResponse
    assert isinstance(resp, ApiSuccessResponse)
    row = next(t for t in resp.data["per_type"] if t["type_name"] == str(RecordType.MARKDOWN))
    assert row["stale"] is True, (
        f"markdown has an edited, un-reindexed file but index-status reports "
        f"stale={row['stale']} — the freshness signal is hardcoded"
    )
