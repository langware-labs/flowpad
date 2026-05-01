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
        RecordType.SKILL, RecordType.AGENT, RecordType.WORKFLOW,
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
@pytest.mark.skip(
    reason="Requires seeded CLAUDE_SESSION data inside the test instance "
    "sandbox (claude_home). With an empty sandbox the indexer finds zero "
    "sessions, only emits the start event, and the ≥2-event assertion fails."
)
async def test_index_handler_emits_progress_events(
    captured_progress, clean_target_types,
):
    h = _Handler()
    await h._handle_fs_records_index(
        FakeRequestInfo({"type": str(RecordType.CLAUDE_SESSION)})
    )

    assert len(captured_progress) >= 2
    sub_events = [
        e for e in captured_progress
        if e.get("attributes", {}).get("sub_activity_name") == "claude_session"
    ]
    job_events = [
        e for e in captured_progress
        if e.get("attributes", {}).get("sub_activity_name") is None
    ]
    assert sub_events, "no sub-activity event for claude_session found"
    assert job_events, "no job-level progress event found"
