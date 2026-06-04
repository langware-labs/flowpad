"""
Fast tests for progress_report WebSocket events.

After the IndexProgressTable refactor, every progress_report carries a
single uniform shape — a per-type table snapshot — instead of separate
job-level vs. sub-activity events. Tests below assert that shape and
basic invariants (monotonic done, terminal event with text='complete',
correct rows for filtered scans/indexes).
"""

from __future__ import annotations

import threading
import time
import uuid
from datetime import datetime, timezone

import pytest

from flow_sdk.fs_store import get_default_records_root, set_default_records_root
from flow_sdk.server.app import app
from starlette.testclient import TestClient
from tests.test_settings import test_service_config


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


def _progress_events(collected: list, job_name: str) -> list[dict]:
    """Return all progress_report events for a given job."""
    out = []
    for m in collected:
        if m.get("message_type") != "flow_data_msg":
            continue
        fd = m.get("flow_data", {})
        if fd.get("element_type") != "progress_report":
            continue
        attrs = fd.get("attributes", {})
        if attrs.get("job_name") != job_name:
            continue
        out.append(attrs)
    return out


def _assert_table_shape(attrs: dict, job_name: str) -> None:
    """Assert the IndexProgressTable wire shape on a single event."""
    assert attrs.get("job_name") == job_name
    assert isinstance(attrs.get("rows"), list)
    assert isinstance(attrs.get("done"), int)
    assert isinstance(attrs.get("total"), int)
    assert attrs["done"] >= 0
    assert attrs["total"] >= 0
    # `current` is a string or null
    current = attrs.get("current")
    assert current is None or isinstance(current, str)
    # `text` is null or "complete"
    text = attrs.get("text")
    assert text is None or text == "complete"
    # Per-row shape
    for row in attrs["rows"]:
        assert isinstance(row.get("type_name"), str)
        assert isinstance(row.get("done"), int)
        assert isinstance(row.get("total"), int)
        assert row["done"] >= 0
        assert row["total"] >= 0
    # ts must be valid ISO-8601 with timezone, recent
    ts = attrs.get("ts")
    assert isinstance(ts, str), f"'ts' should be a string: {ts}"
    parsed = datetime.fromisoformat(ts)
    assert parsed.tzinfo is not None, f"'ts' has no timezone info: {ts}"
    age = (datetime.now(timezone.utc) - parsed).total_seconds()
    assert 0 <= age < 60, f"'ts' is not recent (age={age:.1f}s): {ts}"


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_scan_progress_report_events():
    """Aggregate scan emits IndexProgressTable snapshots with total=0 (unknown)."""
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")

        for i in range(3):
            _create_skill(tc, skill_base, f"fast-scan-{i}")

        scan_url = _cn_url(boot, "scan")
        collected = _collect_ws_during(tc, f"{scan_url}?trigger=manual&limit_types=5")

    events = _progress_events(collected, "scan")
    assert len(events) >= 1, f"Expected progress_report events, got none. All: {collected}"

    for attrs in events:
        _assert_table_shape(attrs, "scan")
        # Scan has unknown totals — table-level total is 0.
        assert attrs["total"] == 0, f"Scan total should be 0 (unknown), got {attrs['total']}"

    # Final event must signal completion.
    final = events[-1]
    assert final["text"] == "complete"
    assert final["current"] is None


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_index_progress_report_events():
    """Aggregate index emits snapshots with totals known up front."""
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")

        for i in range(3):
            _create_skill(tc, skill_base, f"fast-index-{i}")

        index_url = _cn_url(boot, "index")
        collected = _collect_ws_during(tc, f"{index_url}?limit_types=5&limit_per_type=20", method="post")

    events = _progress_events(collected, "index")
    assert len(events) >= 1, f"Expected progress_report events, got none. All: {collected}"

    for attrs in events:
        _assert_table_shape(attrs, "index")
        # Per-row done <= total invariant. Grand-total may briefly exceed when
        # a row is mid-update, but each row individually is bounded.
        for row in attrs["rows"]:
            assert row["done"] <= row["total"], (
                f"Row done > total: {row}"
            )

    final = events[-1]
    assert final["text"] == "complete"
    assert final["current"] is None
    # `limit_per_type=20` may cap a row's `done` below its discovered `total`
    # when many records exist on disk. Each row's `done` must equal
    # min(limit_per_type, total).
    for row in final["rows"]:
        assert row["done"] == min(20, row["total"]), (
            f"Row done should equal min(limit_per_type=20, total): {row}"
        )


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_progress_report_events_monotonic():
    """Grand-total ``done`` is non-decreasing across snapshots within one job."""
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")

        for i in range(3):
            _create_skill(tc, skill_base, f"interleave-{i}")

        scan_url = _cn_url(boot, "scan")
        collected = _collect_ws_during(tc, f"{scan_url}?trigger=manual&limit_types=5")

    events = _progress_events(collected, "scan")
    assert len(events) >= 1, "Expected progress_report events"

    done_values = [e["done"] for e in events]
    for i in range(1, len(done_values)):
        assert done_values[i] >= done_values[i - 1], (
            f"Grand-total done not monotonic: {done_values}"
        )


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_per_type_scan_emits_progress_report():
    """Per-type scan (?type=X) emits a table whose only relevant row is X."""
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")

        for i in range(3):
            _create_skill(tc, skill_base, f"per-type-s-{i}")

        scan_url = _cn_url(boot, "scan")
        collected = _collect_ws_during(tc, f"{scan_url}?type=skill&trigger=manual")

    events = _progress_events(collected, "scan")
    assert len(events) >= 1, f"Expected progress_report events. Got: {collected}"

    final = events[-1]
    assert final["text"] == "complete"
    # Final must contain at least the skill row with done >= 3 created above
    skill_rows = [r for r in final["rows"] if r["type_name"] == "skill"]
    assert len(skill_rows) == 1, f"Expected one 'skill' row, got rows: {final['rows']}"
    assert skill_rows[0]["done"] >= 3


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_per_type_index_emits_progress_report():
    """Per-type index (?type=X) emits a table that completes for that type."""
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")

        for i in range(3):
            _create_skill(tc, skill_base, f"per-type-i-{i}")

        index_url = _cn_url(boot, "index")
        collected = _collect_ws_during(tc, f"{index_url}?type=skill&limit_per_type=20", method="post")

    events = _progress_events(collected, "index")
    assert len(events) >= 1, f"Expected progress_report events. Got: {collected}"

    final = events[-1]
    assert final["text"] == "complete"
    assert final["current"] is None
    skill_rows = [r for r in final["rows"] if r["type_name"] == "skill"]
    assert len(skill_rows) == 1, f"Expected one 'skill' row, got: {final['rows']}"
    row = skill_rows[0]
    assert row["total"] > 0
    # `limit_per_type=20` caps `done` at 20 even when more refs exist on disk;
    # the row's `done` should equal min(limit, total).
    assert row["done"] == min(20, row["total"]), (
        f"Expected done == min(limit_per_type=20, total={row['total']}), got done={row['done']}"
    )
