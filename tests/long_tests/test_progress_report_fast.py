"""
Fast tests for progress_report WebSocket events.

Tests both sub-activity (per-record) and job-level (per-type) progress_report events
using minimal record counts (3 records) so the test suite runs quickly.
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
from tests.test_settings import test_service_config


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.usefixtures("reset_db_for_testclient"),
]


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


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_scan_progress_report_events():
    """Aggregate scan emits progress_report events.

    Uses only 3 skill records so it runs fast.
    Validates:
    - At least 1 progress_report event with job_name='scan'
    - Correct shape: done/total are ints, done <= total
    - Timestamps are valid ISO-8601
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
    all_events = reports["sub_activity"] + reports["job_level"]

    # Must have at least one progress event (sub-activity or job-level)
    assert len(all_events) >= 1, (
        f"Expected progress_report events, got none. All: {collected}"
    )

    # Validate event shape
    for msg in all_events:
        attrs = msg["flow_data"]["attributes"]
        assert attrs["job_name"] == "scan"
        assert isinstance(attrs["done"], int)
        assert isinstance(attrs["total"], int)
        assert attrs["done"] >= 0
        assert attrs["total"] >= 0
        assert attrs["done"] <= attrs["total"]
        _assert_ts(attrs)


# ---------------------------------------------------------------------------
# Test: index progress_report events (fast — 3 records)
# ---------------------------------------------------------------------------


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_index_progress_report_events():
    """Aggregate index emits progress_report events.

    Uses only 3 skill records so it runs fast.
    Validates:
    - At least 1 progress_report event with job_name='index'
    - Correct shape: done/total are ints, done <= total
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
    all_events = reports["sub_activity"] + reports["job_level"]

    # Must have at least one progress event
    assert len(all_events) >= 1, (
        f"Expected progress_report events, got none. All: {collected}"
    )

    # Validate event shape
    for msg in all_events:
        attrs = msg["flow_data"]["attributes"]
        assert attrs["job_name"] == "index"
        assert isinstance(attrs["done"], int)
        assert isinstance(attrs["total"], int)
        assert attrs["done"] >= 0
        assert attrs["total"] >= 0
        assert attrs["done"] <= attrs["total"]
        _assert_ts(attrs)


# ---------------------------------------------------------------------------
# Test: interleaved sub-activity and job-level events
# ---------------------------------------------------------------------------


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_progress_report_events_monotonic():
    """During aggregate scan, progress_report done values are non-decreasing.

    Validates that progress events have monotonically increasing done counts.
    """
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")

        # Create 3 records
        for i in range(3):
            _create_skill(tc, skill_base, f"interleave-{i}")

        scan_url = _cn_url(boot, "scan")
        # Use limit_types=5 so we get multiple types processed
        collected = _collect_ws_during(tc, f"{scan_url}?trigger=manual&limit_types=5")

    reports = _get_progress_reports(collected, "scan")
    all_events = reports["sub_activity"] + reports["job_level"]

    # Must have at least one event
    assert len(all_events) >= 1, "Expected progress_report events"

    # Done values must be non-decreasing across job-level events
    job_events = reports["job_level"]
    if len(job_events) > 1:
        job_done_values = [m["flow_data"]["attributes"]["done"] for m in job_events]
        for i in range(1, len(job_done_values)):
            assert job_done_values[i] >= job_done_values[i - 1], (
                f"Job-level done not monotonic: {job_done_values}"
            )


# ---------------------------------------------------------------------------
# Test: per-type scan also emits progress_report events
# ---------------------------------------------------------------------------


# do not increase timeout without approval
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
    all_events = reports["sub_activity"] + reports["job_level"]

    # Per-type scan emits at least one progress_report event
    assert len(all_events) >= 1, (
        f"Expected progress_report event from per-type scan. Got: {collected}"
    )

    # Last event should show completion (done == total)
    last_event = all_events[-1]["flow_data"]["attributes"]
    assert last_event["done"] == last_event["total"], (
        f"Final event should show completion: done={last_event['done']} total={last_event['total']}"
    )


# ---------------------------------------------------------------------------
# Test: per-type index also emits progress_report events
# ---------------------------------------------------------------------------


# do not increase timeout without approval
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
    all_events = reports["sub_activity"] + reports["job_level"]

    # Per-type index emits at least one progress_report event
    assert len(all_events) >= 1, (
        f"Expected progress_report event from per-type index. Got: {collected}"
    )

    # Last event should show completion (done == total)
    last_event = all_events[-1]["flow_data"]["attributes"]
    assert last_event["done"] == last_event["total"], (
        f"Final event should show completion: done={last_event['done']} total={last_event['total']}"
    )
