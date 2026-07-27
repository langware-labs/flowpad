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


def test_diff_helper_ignores_transport_derived_worker_fields():
    loaded = {"generic": {}, "worker": {"ephemeral": False, "json_stream": False}}
    current = {"generic": {}, "worker": {"ephemeral": True, "json_stream": True}}

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


# ── adopt_worker_session (R03: phantom restart on session rotation) ──────────


def _simulate_started(proc: AgenticProcess) -> None:
    """Mirror the start_pty() success path: capture snapshot + hash."""
    proc.last_started_snapshot = proc._restart_snapshot_payload()
    proc.last_started_hash = proc._restart_snapshot()
    proc.status = "running"
    proc.restart_required = False


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_adopt_session_rotation_alone_keeps_hash_clean():
    """A legitimate resume rotation (only the session id moved) re-points the
    captured snapshot: live hash matches, diff stays empty."""
    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type="claude_code",
        workdir="/tmp/adopt_session_test",
        session_id="session-before",
    )
    _simulate_started(proc)

    assert proc.adopt_worker_session("session-after") is True
    assert proc.session_id == "session-after"
    # Snapshot re-pointed at the new id — no drift, no phantom restart.
    assert proc._restart_snapshot() == proc.last_started_hash
    assert proc.last_started_snapshot["generic"]["session_id"] == "session-after"
    resp = await proc.restart_info_action()
    assert resp.data["changed"] == []


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_adopt_session_does_not_bless_genuine_drift():
    """The rotation-adoption must patch ONLY session-derived fields: config the
    user changed mid-turn (model) still reads as drift afterwards. Guards the
    regression where the turn loop re-captured the WHOLE live payload and
    silently cleared a genuine restart_required."""
    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type="claude_code",
        workdir="/tmp/adopt_session_test",
        session_id="session-before",
        cli_config={"model": "claude-sonnet-4-6"},
    )
    _simulate_started(proc)

    proc.cli_config = {"model": "claude-opus-4-7"}  # genuine drift mid-turn
    assert proc.adopt_worker_session("session-after") is True

    # Hash still mismatches → the save() hook keeps restart_required True.
    assert proc._restart_snapshot() != proc.last_started_hash
    resp = await proc.restart_info_action()
    fields = {(c["section"], c["field"]) for c in resp.data["changed"]}
    assert ("worker", "model") in fields
    # And the session fields themselves are NOT part of the reported drift.
    assert ("generic", "session_id") not in fields


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_adopt_session_first_adoption_sets_full_baseline():
    """A pure-headless process (never start_pty'd → no snapshot) establishes
    its full launch baseline on first adoption."""
    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type="claude_code",
        workdir="/tmp/adopt_session_test",
    )
    assert proc.last_started_snapshot is None

    assert proc.adopt_worker_session("session-first") is True
    assert proc.last_started_snapshot is not None
    assert proc.last_started_snapshot["generic"]["session_id"] == "session-first"
    assert proc._restart_snapshot() == proc.last_started_hash


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_adopt_session_noop_on_same_or_empty_id():
    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type="claude_code",
        session_id="session-x",
    )
    assert proc.adopt_worker_session("session-x") is False
    assert proc.adopt_worker_session("") is False


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_transport_switch_does_not_change_restart_hash():
    """PTY⇄CLI transport intent flips codex's ephemeral/json_stream launch
    options; both restart comparators must ignore them (shared
    TRANSPORT_DERIVED_WORKER_FIELDS), so the hash is stable across the flip."""
    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type="codex",
        workdir="/tmp/transport_switch_test",
        pty_mode=True,
    )
    _simulate_started(proc)
    # Transport fields differ between modes in the raw payload...
    pty_worker = proc._restart_snapshot_payload()["worker"]
    proc.pty_mode = False
    cli_worker = proc._restart_snapshot_payload()["worker"]
    assert (pty_worker["ephemeral"], pty_worker["json_stream"]) != (
        cli_worker["ephemeral"],
        cli_worker["json_stream"],
    )
    # ...but the comparators exclude them: no drift either way.
    assert proc._restart_snapshot() == proc.last_started_hash
    assert AgenticProcess._diff_snapshot_fields(
        proc.last_started_snapshot, proc._restart_snapshot_payload()
    ) == []
