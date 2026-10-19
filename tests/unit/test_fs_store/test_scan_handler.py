"""Integration tests for `_handle_fs_records_scan` — the HTTP scan endpoint.

Runs against the real user ``~/.claude/`` via the shared indexer (same fixture
discipline as ``test_indexer_parity.py``). Asserts response shape, progress
event emission, and scan_log writes.
"""

from __future__ import annotations

import time
from typing import Any

import pytest

from flow_sdk.builtin.faas.fs_records_actions import FsRecordsActionsMixin
from flow_sdk.builtin.faas.in_process_activity import InProcessActivity
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import (
    PROGRESS_TEXT_COMPLETE,
    FSIndexer,
    IndexProgressTable,
    TypeProgressRow,
    index_log,
    reset_shared_indexer,
)
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
    """Minimal mixin instantiation for handler tests."""

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
    """Ensure each test starts with a fresh shared indexer."""
    reset_shared_indexer()
    yield
    reset_shared_indexer()


@pytest.fixture
def captured_progress(monkeypatch):
    """Monkeypatch broadcast_progress to capture FlowData events."""
    events: list[dict] = []

    async def fake(to_entity: str, flow_data: Any) -> None:
        events.append(flow_data)

    monkeypatch.setattr(
        "flow_sdk.core.network.resource_tracker.broadcast_progress", fake,
    )
    return events


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_scan_handler_aggregate_shape(captured_progress):
    """No type param → response has `types`, `grand_total`, `scan_ms`."""
    h = _Handler()
    resp = await h._handle_fs_records_scan(FakeRequestInfo({}))

    from flow_sdk.responses.response import ApiSuccessResponse
    assert isinstance(resp, ApiSuccessResponse)
    data = resp.data
    assert "types" in data
    assert "grand_total" in data
    assert "scan_ms" in data
    assert isinstance(data["types"], list)
    assert isinstance(data["grand_total"], int)
    # Every type entry must have count/total_bytes/avg_bytes
    for t in data["types"]:
        assert "type" in t
        assert "count" in t
        assert "total_bytes" in t
        assert "avg_bytes" in t

    # Per-type `scan_ms` must be MEASURED, not a placeholder. The field was
    # assigned the literal 0.0 at both bucket-construction sites
    # (fs_records_actions.py `bucket["scan_ms"] = 0.0`), so every row reported
    # 0.0 while the aggregate reported the real number — measured on a live
    # backend: aggregate scan_ms=3442.3 with 35/35 rows at 0.0. Presence-only
    # assertions (`"scan_ms" in data`) cannot catch a dead field, which is why
    # this went unnoticed.
    scanned = [t for t in data["types"] if t["count"] > 0]
    if scanned and data["scan_ms"] > 0:
        assert sum(t["scan_ms"] for t in scanned) > 0.0, (
            f"all {len(scanned)} scanned type rows report scan_ms=0.0 while the "
            f"aggregate reports {data['scan_ms']}ms — per-type timing is a placeholder"
        )


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_scan_handler_single_type_shape(captured_progress):
    """?type=claude_session → flat response with type/count/total_bytes/records."""
    h = _Handler()
    resp = await h._handle_fs_records_scan(
        FakeRequestInfo({"type": str(RecordType.CLAUDE_SESSION)})
    )

    from flow_sdk.responses.response import ApiSuccessResponse
    assert isinstance(resp, ApiSuccessResponse)
    data = resp.data
    assert data["type"] == "claude_session"
    assert "count" in data
    assert "total_bytes" in data
    assert "avg_bytes" in data
    assert "scan_ms" in data
    assert "records" in data
    assert "min_bytes" in data
    assert "max_bytes" in data
    assert "last_scan_at" in data


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_scan_handler_unknown_type_400(captured_progress):
    h = _Handler()
    resp = await h._handle_fs_records_scan(
        FakeRequestInfo({"type": "no_such_type_xyz"})
    )
    assert resp.status_code == 400


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_scan_handler_emits_table_snapshots(captured_progress):
    """Scan emits at least the initial + terminal IndexProgressTable snapshots."""
    h = _Handler()
    await h._handle_fs_records_scan(FakeRequestInfo({}))

    # Filter to progress_report broadcasts only.
    snapshots = [
        ev["attributes"] for ev in captured_progress
        if ev.get("element_type") == "progress_report"
        and ev.get("attributes", {}).get("job_name") == "scan"
    ]
    assert len(snapshots) >= 2, (
        f"expected ≥2 snapshots (initial + terminal), got {len(snapshots)}"
    )

    # Every snapshot has the table shape
    for s in snapshots:
        assert isinstance(s.get("rows"), list)
        assert isinstance(s.get("done"), int)
        # Scan total is unknown — always 0
        assert s.get("total") == 0

    # Last snapshot is the authoritative completion event
    final = snapshots[-1]
    assert final["text"] == "complete"
    assert final["current"] is None


@pytest.mark.asyncio
async def test_typed_scan_projects_and_diffs_only_terminal_type(
    tmp_path,
    monkeypatch,
    captured_progress,
):
    skill_path = tmp_path / "skill.md"
    session_path = tmp_path / "session.jsonl"
    skill_path.write_text("# skill\n")
    session_path.write_text("{}\n")
    nodes = [
        FSRef(skill_path, record_type=RecordType.SKILL),
        FSRef(session_path, record_type=RecordType.CLAUDE_SESSION),
    ]
    captured: dict[str, Any] = {}

    class FakeIndexer:
        async def scan(self, opts):
            captured["requested_types"] = opts.types
            row = TypeProgressRow(type_name="skill", done=1, total=0)
            await opts.on_progress(IndexProgressTable(
                job_name="scan",
                rows=(row,),
                current="skill",
                done=1,
                total=0,
            ))
            await opts.on_progress(IndexProgressTable(
                job_name="scan",
                rows=(row,),
                current=None,
                done=1,
                total=0,
                text=PROGRESS_TEXT_COMPLETE,
            ))
            return nodes

    monkeypatch.setattr(
        "flow_sdk.fs_store.indexer.get_shared_indexer",
        lambda: FakeIndexer(),
    )

    async def all_scope(*, create_missing):
        return object()

    monkeypatch.setattr(
        "flow_sdk.fs_store.operations.all_projects.get_all_scope_filter",
        all_scope,
    )
    handler = _Handler()

    async def scoped_roots(_scope_filter, *, foreground):
        return ()

    monkeypatch.setattr(handler, "_resolve_scoped_roots", scoped_roots)
    identity_types: list[RecordType] = []

    def ref_id(ref):
        identity_types.append(ref.record_type)
        return f"{ref.record_type}-id"

    monkeypatch.setattr(handler, "_ref_id", ref_id)

    def discover(type_names):
        captured["diff_types"] = set(type_names)
        return {}

    monkeypatch.setattr(
        FSIndexer,
        "_discover_records_dir_ids",
        staticmethod(discover),
    )

    def append_scan(**kwargs):
        captured["scan_log"] = kwargs
        captured["activity_alive"] = (
            handler._activity is not None and not handler._activity.is_complete
        )
        captured["terminal_seen_during_postprocess"] = any(
            event.get("attributes", {}).get("text") == PROGRESS_TEXT_COMPLETE
            for event in captured_progress
        )
        return "now"

    monkeypatch.setattr(index_log, "append_scan", append_scan)

    response = await handler._handle_fs_records_scan(
        FakeRequestInfo({"type": "skill", "user": None, "projects": None})
    )

    assert captured["requested_types"] == [RecordType.SKILL]
    assert captured["diff_types"] == {"skill"}
    assert identity_types == [RecordType.SKILL, RecordType.SKILL]
    assert response.data["type"] == "skill"
    assert response.data["count"] == 1
    assert captured["scan_log"]["type_name"] == "skill"
    assert captured["activity_alive"] is True
    assert captured["terminal_seen_during_postprocess"] is False
    assert captured_progress[-1]["attributes"]["text"] == PROGRESS_TEXT_COMPLETE
    assert handler._activity is None


def test_typed_non_indexable_scan_is_projected_but_not_diffed(
    tmp_path,
    monkeypatch,
):
    folder = tmp_path / "folder"
    folder.mkdir()
    handler = _Handler()
    identity_types: list[RecordType] = []

    def project_identity(ref):
        identity_types.append(ref.record_type)
        return None

    monkeypatch.setattr(handler, "_ref_id", project_identity)
    captured: dict[str, Any] = {}

    def discover(type_names):
        captured["diff_types"] = set(type_names)
        return {}

    monkeypatch.setattr(
        FSIndexer,
        "_discover_records_dir_ids",
        staticmethod(discover),
    )
    monkeypatch.setattr(index_log, "append_scan", lambda **kwargs: "now")

    response = handler._project_fs_records_scan(
        nodes=[FSRef(folder, record_type=RecordType.FOLDER)],
        filter_type="folder",
        types_filter=[RecordType.FOLDER],
        trigger="test",
        walk_ms=1.0,
        started_at=time.perf_counter(),
        scope_explicit=False,
    )

    assert response.data["type"] == "folder"
    # `scan_ms` is the WHOLE request, `walk_ms` only the walk's share — the split
    # that stopped a 34s scan from advertising itself as 0.5s.
    assert response.data["walk_ms"] == 1.0
    assert response.data["count"] == 1
    assert response.data["records"][0]["id"] == str(folder)
    assert response.data["min_bytes"] == folder.stat().st_size
    assert response.data["max_bytes"] == folder.stat().st_size
    assert response.data["new"] == 0
    assert response.data["pending"] == 0
    assert identity_types == [RecordType.FOLDER]
    assert captured["diff_types"] == set()
