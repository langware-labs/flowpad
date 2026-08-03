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

    def get(self, key, default=""):
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
    captured_progress, clean_target_types,
):
    """?type=claude_session → only CLAUDE_SESSION rows written."""
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
            "duration_ms": 0.0,
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
