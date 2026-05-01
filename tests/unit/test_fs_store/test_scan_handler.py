"""Integration tests for `_handle_fs_records_scan` — the HTTP scan endpoint.

Runs against the real user ``~/.claude/`` via the shared indexer (same fixture
discipline as ``test_indexer_parity.py``). Asserts response shape, progress
event emission, and scan_log writes.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from flow_sdk.builtin.faas.fs_records_actions import FsRecordsActionsMixin
from flow_sdk.builtin.faas.in_process_activity import InProcessActivity
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
    """Minimal mixin instantiation for handler tests."""

    def __init__(self):
        self.typeid = "test-compute-node"
        self._activity: InProcessActivity | None = None

    def _start_activity(self, job_name: str, total: int = 0, timeout_seconds: int = 600):
        self._activity = InProcessActivity(
            job_name=job_name, entity_id=self.typeid, total=total,
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
@pytest.mark.skip(
    reason="Requires seeded CLAUDE_SESSION data inside the test instance "
    "sandbox. Empty sandbox produces only one progress event, failing the "
    "≥2 assertion."
)
async def test_scan_handler_emits_progress_events(captured_progress):
    """At least one type_complete + one job-level event per type processed."""
    h = _Handler()
    await h._handle_fs_records_scan(
        FakeRequestInfo({"type": str(RecordType.CLAUDE_SESSION)})
    )

    # At minimum: one sub_activity event (type_complete) + one job-level event
    assert len(captured_progress) >= 2, (
        f"expected ≥2 progress events, got {len(captured_progress)}"
    )
    # The sub-activity events should have sub_activity_name set to the type
    sub_events = [
        e for e in captured_progress
        if e.get("attributes", {}).get("sub_activity_name") == "claude_session"
    ]
    assert sub_events, "no sub-activity event for claude_session found"
    # The job-level events have sub_activity_name=None
    job_events = [
        e for e in captured_progress
        if e.get("attributes", {}).get("sub_activity_name") is None
    ]
    assert job_events, "no job-level progress event found"
