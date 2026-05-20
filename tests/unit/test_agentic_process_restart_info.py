"""Unit tests for ``AgenticProcess.restart_info_action`` and the
``_diff_snapshot_fields`` helper that powers it.

The action surfaces the loaded-vs-current diff used by the UI's
"Command Status" debug viewer to explain *why* a restart is required.
Tests drive real entities and call the action method directly — no
HTTP mock layer.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums.worker_enums import WorkerType


# ── _diff_snapshot_fields ─────────────────────────────────────────────────────


def test_diff_helper_returns_empty_when_loaded_is_none():
    current = {"generic": {"workdir": "/a"}, "worker": {"model": "sonnet"}}
    assert AgenticProcess._diff_snapshot_fields(None, current) == []


def test_diff_helper_returns_empty_when_equal():
    payload = {"generic": {"workdir": "/a"}, "worker": {"model": "sonnet"}}
    assert AgenticProcess._diff_snapshot_fields(payload, payload) == []


def test_diff_helper_reports_generic_change():
    loaded = {"generic": {"workdir": "/a"}, "worker": {"model": "sonnet"}}
    current = {"generic": {"workdir": "/b"}, "worker": {"model": "sonnet"}}
    changes = AgenticProcess._diff_snapshot_fields(loaded, current)
    assert changes == [
        {"section": "generic", "field": "workdir", "loaded": "/a", "current": "/b"}
    ]


def test_diff_helper_reports_worker_change():
    loaded = {"generic": {"workdir": "/a"}, "worker": {"model": "sonnet"}}
    current = {"generic": {"workdir": "/a"}, "worker": {"model": "opus"}}
    changes = AgenticProcess._diff_snapshot_fields(loaded, current)
    assert changes == [
        {"section": "worker", "field": "model", "loaded": "sonnet", "current": "opus"}
    ]


def test_diff_helper_reports_multiple_changes():
    loaded = {"generic": {"workdir": "/a", "session_id": "s1"}, "worker": {"model": "sonnet"}}
    current = {"generic": {"workdir": "/b", "session_id": "s1"}, "worker": {"model": "opus"}}
    changes = AgenticProcess._diff_snapshot_fields(loaded, current)
    fields = {(c["section"], c["field"]) for c in changes}
    assert fields == {("generic", "workdir"), ("worker", "model")}


def test_diff_helper_normalizes_enums_and_paths():
    """Normalization must match the hash semantics — enum vs str form of the
    same value must not show up as a diff."""
    loaded = {"generic": {"worker_type": "claude_code"}, "worker": {}}
    current = {"generic": {"worker_type": WorkerType.CLAUDE_CODE}, "worker": {}}
    assert AgenticProcess._diff_snapshot_fields(loaded, current) == []


# ── restart_info_action ───────────────────────────────────────────────────────


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_restart_info_before_first_start():
    """Process never started: ``loaded`` is None, ``current`` populated,
    ``changed`` is empty, ``running`` is False."""
    proc = AgenticProcess(id=str(uuid.uuid4()), worker_type="claude_code")
    resp = await proc.restart_info_action()
    data = resp.data
    assert data["loaded"] is None
    assert data["running"] is False
    assert data["restart_required"] is False
    # The snapshot keys ``worker_type`` to the driver name (e.g. "claude"),
    # not the entity's worker_type field (e.g. "claude_code") — matches the
    # form used everywhere else in the snapshot pipeline.
    assert data["worker_type"] == "claude"
    assert "generic" in data["current"]
    assert "worker" in data["current"]
    assert data["changed"] == []


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_restart_info_after_simulated_start_no_drift():
    """After simulating a successful start (capture snapshot), the loaded and
    current payloads match and ``changed`` is empty."""
    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type="claude_code",
        workdir="/tmp/restart_info_test",
    )
    # Simulate the start_pty() success path: capture snapshot + hash, flag off.
    proc.last_started_snapshot = proc._restart_snapshot_payload()
    proc.last_started_hash = proc._restart_snapshot()
    proc.status = "running"
    proc.restart_required = False

    resp = await proc.restart_info_action()
    data = resp.data
    assert data["loaded"] is not None
    assert data["running"] is True
    assert data["restart_required"] is False
    assert data["changed"] == []
    # The two payloads must agree on every key (normalized form).
    assert AgenticProcess._normalize_restart_value(data["loaded"]) == \
           AgenticProcess._normalize_restart_value(data["current"])


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_restart_info_post_start_workdir_edit():
    """Edit a tracked generic field after start: ``changed`` lists the
    workdir diff, ``restart_required`` is True."""
    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type="claude_code",
        workdir="/tmp/restart_info_initial",
    )
    proc.last_started_snapshot = proc._restart_snapshot_payload()
    proc.last_started_hash = proc._restart_snapshot()
    proc.status = "running"
    proc.restart_required = False

    # User edits workdir after the worker is already running.
    proc.workdir = "/tmp/restart_info_after_edit"
    # Mirror the save-hook's restart-flag flip (we don't go through save() to
    # avoid the DB layer; the flag's behavior is covered by long_tests).
    if proc._restart_snapshot() != proc.last_started_hash:
        proc.restart_required = True

    resp = await proc.restart_info_action()
    data = resp.data
    assert data["restart_required"] is True
    # workdir lives in the generic snapshot (and also surfaces in the
    # worker-side CLI options for Claude/Codex). At minimum it must show
    # up in the generic section with the correct before/after values.
    generic_workdir = [
        c for c in data["changed"]
        if c["section"] == "generic" and c["field"] == "workdir"
    ]
    assert len(generic_workdir) == 1, data["changed"]
    assert generic_workdir[0]["loaded"] == "/tmp/restart_info_initial"
    assert generic_workdir[0]["current"] == "/tmp/restart_info_after_edit"


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_restart_info_post_start_worker_field_edit():
    """Edit a worker-specific field (Claude model) after start: ``changed``
    contains a single entry in the ``worker`` section."""
    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type="claude_code",
        cli_config={"model": "claude-sonnet-4-6"},
    )
    proc.last_started_snapshot = proc._restart_snapshot_payload()
    proc.last_started_hash = proc._restart_snapshot()
    proc.status = "running"
    proc.restart_required = False

    proc.cli_config = {"model": "claude-opus-4-7"}
    if proc._restart_snapshot() != proc.last_started_hash:
        proc.restart_required = True

    resp = await proc.restart_info_action()
    data = resp.data
    assert data["restart_required"] is True
    worker_changes = [c for c in data["changed"] if c["section"] == "worker"]
    assert worker_changes, f"expected at least one worker-section change, got {data['changed']}"
    fields = {c["field"] for c in worker_changes}
    assert "model" in fields


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_restart_info_non_tracked_field_edit():
    """Edit a non-tracked field (e.g. ``favorite_index``): ``changed`` stays
    empty and ``restart_required`` stays False."""
    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type="claude_code",
        workdir="/tmp/restart_info_initial",
    )
    proc.last_started_snapshot = proc._restart_snapshot_payload()
    proc.last_started_hash = proc._restart_snapshot()
    proc.status = "running"
    proc.restart_required = False

    proc.favorite_index = 7
    # Mirror the save-hook logic: only flips on snapshot mismatch.
    if proc._restart_snapshot() != proc.last_started_hash:
        proc.restart_required = True

    resp = await proc.restart_info_action()
    data = resp.data
    assert data["restart_required"] is False
    assert data["changed"] == []
