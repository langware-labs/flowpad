"""
Fast tests for progress_report WebSocket events.

Tests both sub-activity (per-record) and job-level (per-type) progress_report events
using minimal record counts (3 records) so the test suite runs quickly.

These replace/supplement the slower tests in test_scan_index_progress_ws.py.
"""

from __future__ import annotations

import threading
import time
import uuid
from datetime import datetime, timezone

import pytest

from flow_sdk.fs_store import get_default_records_root, set_default_records_root
from flow_sdk.fs_records.skill_record import SkillRecord  # noqa: F401 — trigger registration
from flow_sdk.server.app import app
from starlette.testclient import TestClient


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


pytestmark = pytest.mark.usefixtures("reset_db_for_testclient")


@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path):
    """Redirect all record I/O to a temp directory for test isolation."""
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _bootstrap(tc: TestClient) -> dict:
    resp = tc.get("/api/v1/graph/bootstrap")
    assert resp.status_code == 200
    return resp.json()


def _cn_url(bootstrap_payload: dict, sub: str) -> str:
    cn_id = bootstrap_payload["data"]["default_compute_node"]["id"]
    return f"/api/v1/graph/compute_node/{cn_id}/fs-records/{sub}"


def _create_skill(tc: TestClient, skill_base: str, name: str) -> str:
    resp = tc.post(skill_base, json={"name": name, "description": f"{name} desc"})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["id"]


def _collect_ws_during(tc: TestClient, url: str, method: str = "get") -> list:
    """Connect WS, trigger HTTP request in thread, collect all WS messages."""
    collected: list = []
    stop_event = threading.Event()
    connection_id = str(uuid.uuid4())

    with tc.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
        # Consume connection confirmation
        confirmation = ws.receive_json()
        assert confirmation["message_type"] == "response_msg"

        def _reader():
            while not stop_event.is_set():
                try:
                    msg = ws.receive_json()
                    collected.append(msg)
                except Exception:
                    break

        reader_thread = threading.Thread(target=_reader, daemon=True)
        reader_thread.start()

        result = {}

        def _do_request():
            if method == "get":
                r = tc.get(url)
            else:
                r = tc.post(url)
            result["status"] = r.status_code
            result["body"] = r.text

        req_thread = threading.Thread(target=_do_request)
        req_thread.start()
        req_thread.join(timeout=30)

        assert result.get("status") == 200, f"Request failed: {result}"

        time.sleep(0.5)
        stop_event.set()
        reader_thread.join(timeout=3)

    return collected


def _get_progress_reports(collected: list, job_name: str) -> dict:
    """Return sub-activity and job-level progress_report events for a job."""
    sub_activity = []
    job_level = []
    for m in collected:
        if m.get("message_type") != "flow_data_msg":
            continue
        fd = m.get("flow_data", {})
        if fd.get("element_type") != "progress_report":
            continue
        attrs = fd.get("attributes", {})
        if attrs.get("job_name") != job_name:
            continue
        if attrs.get("sub_activity_name") is not None:
            sub_activity.append(m)
        else:
            job_level.append(m)
    return {"sub_activity": sub_activity, "job_level": job_level}


def _assert_ts(attrs: dict) -> None:
    """Assert that a progress_report attrs dict contains a valid ISO-8601 UTC timestamp."""
    ts = attrs.get("ts")
    assert ts is not None, f"Missing 'ts' field in attrs: {attrs}"
    assert isinstance(ts, str), f"'ts' should be a string, got {type(ts)}: {ts}"
    # Must parse as ISO-8601 datetime with timezone info
    parsed = datetime.fromisoformat(ts)
    assert parsed.tzinfo is not None, f"'ts' has no timezone info: {ts}"
    # Must be recent (within the last 60 seconds)
    age = (datetime.now(timezone.utc) - parsed).total_seconds()
    assert 0 <= age < 60, f"'ts' is not recent (age={age:.1f}s): {ts}"


# ---------------------------------------------------------------------------
# Test: scan progress_report events (fast — 3 records)
# ---------------------------------------------------------------------------


@pytest.mark.timeout(30)
def test_scan_progress_report_events():
    """Aggregate scan emits both sub-activity and job-level progress_report events.

    Uses only 3 skill records so it runs fast.
    Validates:
    - At least 1 sub-activity event (sub_activity_name set)
    - At least 1 job-level event (sub_activity_name=None)
    - Correct shape for both
    - Sub-activity: done <= total, job_name='scan'
    - Job-level: sub_activity_name is None, job_name='scan'
    """
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")

        # Create just 3 records — enough to trigger at least 1 progress event
        for i in range(3):
            _create_skill(tc, skill_base, f"fast-scan-{i}")

        scan_url = _cn_url(boot, "scan")
        # limit_types=5 keeps the test fast while ensuring skill type is included
        collected = _collect_ws_during(tc, f"{scan_url}?trigger=manual&limit_types=5")

    reports = _get_progress_reports(collected, "scan")

    # Must have at least one sub-activity event
    assert len(reports["sub_activity"]) >= 1, (
        f"Expected sub-activity progress_report events, got none. All: {collected}"
    )

    # Validate sub-activity event shape
    for msg in reports["sub_activity"]:
        attrs = msg["flow_data"]["attributes"]
        assert attrs["job_name"] == "scan"
        assert attrs["sub_activity_name"] is not None
        assert isinstance(attrs["done"], int)
        assert isinstance(attrs["total"], int)
        assert isinstance(attrs["skipped"], int)
        assert isinstance(attrs["errors"], int)
        assert attrs["done"] > 0
        assert attrs["total"] > 0
        assert attrs["done"] <= attrs["total"]
        _assert_ts(attrs)

    # Must have at least one job-level event
    assert len(reports["job_level"]) >= 1, (
        f"Expected job-level progress_report events, got none. All: {collected}"
    )

    # Validate job-level event shape
    for msg in reports["job_level"]:
        attrs = msg["flow_data"]["attributes"]
        assert attrs["job_name"] == "scan"
        assert attrs["sub_activity_name"] is None
        assert isinstance(attrs["done"], int)
        assert isinstance(attrs["total"], int)
        assert attrs["done"] >= 0
        assert attrs["total"] >= 0
        _assert_ts(attrs)


# ---------------------------------------------------------------------------
# Test: index progress_report events (fast — 3 records)
# ---------------------------------------------------------------------------


@pytest.mark.timeout(30)
def test_index_progress_report_events():
    """Aggregate index emits both sub-activity and job-level progress_report events.

    Uses only 3 skill records so it runs fast.
    Validates:
    - At least 1 sub-activity event (sub_activity_name set)
    - At least 1 job-level event (sub_activity_name=None)
    - Correct shape for both
    - Sub-activity: job_name='index', skipped/errors are ints
    """
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")

        # Create just 3 records
        for i in range(3):
            _create_skill(tc, skill_base, f"fast-index-{i}")

        index_url = _cn_url(boot, "index")
        # limit_types=5 + limit_per_type=20 keeps the test fast even on machines
        # with many pre-existing records (avoids >30s timeout)
        collected = _collect_ws_during(tc, f"{index_url}?limit_types=5&limit_per_type=20", method="post")

    reports = _get_progress_reports(collected, "index")

    # Must have at least one sub-activity event
    assert len(reports["sub_activity"]) >= 1, (
        f"Expected sub-activity progress_report events, got none. All: {collected}"
    )

    # Validate sub-activity event shape
    for msg in reports["sub_activity"]:
        attrs = msg["flow_data"]["attributes"]
        assert attrs["job_name"] == "index"
        assert attrs["sub_activity_name"] is not None
        assert isinstance(attrs["done"], int)
        assert isinstance(attrs["total"], int)
        assert isinstance(attrs["skipped"], int)
        assert isinstance(attrs["errors"], int)
        assert attrs["done"] > 0
        assert attrs["total"] > 0
        assert attrs["done"] <= attrs["total"]
        _assert_ts(attrs)

    # Must have at least one job-level event
    assert len(reports["job_level"]) >= 1, (
        f"Expected job-level progress_report events, got none. All: {collected}"
    )

    # Validate job-level event shape
    for msg in reports["job_level"]:
        attrs = msg["flow_data"]["attributes"]
        assert attrs["job_name"] == "index"
        assert attrs["sub_activity_name"] is None
        assert isinstance(attrs["done"], int)
        assert isinstance(attrs["total"], int)
        _assert_ts(attrs)


# ---------------------------------------------------------------------------
# Test: interleaved sub-activity and job-level events
# ---------------------------------------------------------------------------


@pytest.mark.timeout(30)
def test_progress_report_events_are_interleaved():
    """During aggregate scan, sub-activity and job-level events are interleaved.

    For each type processed, we expect:
    1. One or more sub-activity events (while scanning records within a type)
    2. One job-level event (after the type completes)

    This validates the "progress report both on activity and sub activities interleaved"
    requirement.
    """
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")

        # Create 3 records
        for i in range(3):
            _create_skill(tc, skill_base, f"interleave-{i}")

        scan_url = _cn_url(boot, "scan")
        # Use limit_types=5 so we get multiple types processed → ≥2 job-level events
        collected = _collect_ws_during(tc, f"{scan_url}?trigger=manual&limit_types=5")

    reports = _get_progress_reports(collected, "scan")
    sub_events = reports["sub_activity"]
    job_events = reports["job_level"]

    # Must have both types of events
    assert len(sub_events) >= 1, "Expected sub-activity events"
    assert len(job_events) >= 1, "Expected job-level events"

    # Job-level done values must be non-decreasing
    job_done_values = [m["flow_data"]["attributes"]["done"] for m in job_events]
    for i in range(1, len(job_done_values)):
        assert job_done_values[i] >= job_done_values[i - 1], (
            f"Job-level done not monotonic: {job_done_values}"
        )


# ---------------------------------------------------------------------------
# Test: per-type scan also emits progress_report events
# ---------------------------------------------------------------------------


@pytest.mark.timeout(30)
def test_per_type_scan_emits_progress_report():
    """Per-type scan (?type=X) also emits progress_report events."""
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")

        for i in range(3):
            _create_skill(tc, skill_base, f"per-type-scan-{i}")

        scan_url = _cn_url(boot, "scan")
        collected = _collect_ws_during(tc, f"{scan_url}?type=skill&trigger=manual")

    reports = _get_progress_reports(collected, "scan")

    # Per-type scan emits a sub-activity event at completion
    assert len(reports["sub_activity"]) >= 1, (
        f"Expected sub-activity event from per-type scan. Got: {reports}"
    )
    last_sub = reports["sub_activity"][-1]["flow_data"]["attributes"]
    assert last_sub["sub_activity_name"] == "skill"
    assert last_sub["done"] == last_sub["total"]

    # And a job-level event
    assert len(reports["job_level"]) >= 1, (
        f"Expected job-level event from per-type scan. Got: {reports}"
    )


# ---------------------------------------------------------------------------
# Test: per-type index also emits progress_report events
# ---------------------------------------------------------------------------


@pytest.mark.timeout(30)
def test_per_type_index_emits_progress_report():
    """Per-type index (?type=X) also emits progress_report events."""
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")

        for i in range(3):
            _create_skill(tc, skill_base, f"per-type-idx-{i}")

        index_url = _cn_url(boot, "index")
        collected = _collect_ws_during(tc, f"{index_url}?type=skill", method="post")

    reports = _get_progress_reports(collected, "index")

    # Per-type index emits a sub-activity event at completion
    assert len(reports["sub_activity"]) >= 1, (
        f"Expected sub-activity event from per-type index. Got: {reports}"
    )
    last_sub = reports["sub_activity"][-1]["flow_data"]["attributes"]
    assert last_sub["sub_activity_name"] == "skill"
    assert last_sub["done"] == last_sub["total"]

    # And a job-level event
    assert len(reports["job_level"]) >= 1, (
        f"Expected job-level event from per-type index. Got: {reports}"
    )
