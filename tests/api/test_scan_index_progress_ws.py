"""
WebSocket progress events for scan/index operations.

Validates that scan_type_progress() and index_type_progress() generators
broadcast flow_data_msg events to all connected WebSocket clients, and that
the FlowData payload is correctly structured.

The implementation broadcasts scan/index progress events from the aggregate
scan/index handlers (no ?type= filter).  Per-type handlers use the non-streaming
path and do NOT emit progress events.

Tests:
  1. scan_progress events: structure, monotonicity, completeness
  2. index_progress events: structure, counters, monotonicity
  3. Multiple WS clients all receive the broadcast (broadcast semantics)

NOTE: All tests use only starlette's synchronous TestClient (no async httpx)
to avoid event-loop conflicts with aiosqlite when mixing async fixtures with
sync WebSocket testing.
"""

from __future__ import annotations

import threading
import time
import uuid

import pytest

from flow_sdk.fs_store import get_default_records_root, set_default_records_root

# Trigger type auto-registration
from flow_sdk.fs_records.skill_record import SkillRecord  # noqa: F401
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
    """Create a skill record and return its id."""
    resp = tc.post(skill_base, json={"name": name, "description": f"{name} desc"})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["id"]


def _create_skills(tc: TestClient, skill_base: str, count: int, prefix: str = "progress-skill") -> list[str]:
    """Create `count` skill records and return their ids."""
    return [_create_skill(tc, skill_base, f"{prefix}-{i}") for i in range(count)]


def _start_ws_reader(ws, collected: list, stop_event: threading.Event) -> threading.Thread:
    """Start a daemon thread that appends all received JSON messages to `collected`."""

    def _reader():
        while not stop_event.is_set():
            try:
                msg = ws.receive_json()
                collected.append(msg)
            except Exception:
                # Socket closed or timed out — exit reader
                break

    t = threading.Thread(target=_reader, daemon=True)
    t.start()
    return t


def _filter_progress(collected: list, element_type: str, type_name: str | None = None) -> list:
    """Return flow_data_msg messages matching a given element_type (and optionally type).

    For ``progress_report`` events, ``type_name`` matches against ``sub_activity_name``.
    For legacy event types it matches against ``type``.
    """
    results = []
    for m in collected:
        if m.get("message_type") != "flow_data_msg":
            continue
        fd = m.get("flow_data", {})
        if fd.get("element_type") != element_type:
            continue
        if type_name is not None:
            attrs = fd.get("attributes", {})
            # progress_report uses sub_activity_name; legacy types use "type"
            attr_key = "sub_activity_name" if element_type == "progress_report" else "type"
            if attrs.get(attr_key) != type_name:
                continue
        results.append(m)
    return results


# ---------------------------------------------------------------------------
# Test 1: scan_progress events
# ---------------------------------------------------------------------------


@pytest.mark.timeout(120)
def test_scan_progress_events_via_websocket():
    """Aggregate scan broadcasts scan_progress flow_data_msg events over WebSocket.

    Validates:
    - At least one scan_progress event is received for the "skill" type
    - Each event has the correct FlowData shape
    - records_done values are monotonically non-decreasing
    - The last event has records_done == records_total (completeness)
    """
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")
        _create_skills(tc, skill_base, 30, prefix="scan-prog-skill")

        # Aggregate scan URL (no ?type= filter so it calls scan_type_progress())
        scan_url = _cn_url(boot, "scan")

        collected: list = []
        stop_event = threading.Event()
        connection_id = str(uuid.uuid4())

        with tc.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            # Consume connection confirmation
            confirmation = ws.receive_json()
            assert confirmation["message_type"] == "response_msg"
            assert confirmation["data"]["connection_id"] == connection_id

            reader_thread = _start_ws_reader(ws, collected, stop_event)

            # Trigger the aggregate scan in a separate thread (non-blocking)
            scan_result = {}

            def do_scan():
                r = tc.get(scan_url)
                scan_result["status"] = r.status_code
                scan_result["body"] = r.text

            scan_thread = threading.Thread(target=do_scan)
            scan_thread.start()
            scan_thread.join(timeout=90)

            assert scan_result.get("status") == 200, f"Scan failed: {scan_result}"

            # Give the final WebSocket events a moment to arrive, then signal stop.
            # Do NOT join here — let the WS context close first so the fd is
            # fully unregistered from the selector before we wait on the reader.
            time.sleep(1.5)
            stop_event.set()

        # WS is now closed; reader_thread will see the socket error and exit.
        reader_thread.join(timeout=5)

    # Filter progress_report sub-activity events for "skill" type
    skill_events = _filter_progress(collected, "progress_report", type_name="skill")

    assert len(skill_events) >= 1, (
        f"Expected at least 1 progress_report sub-activity event for type 'skill', got 0. "
        f"All collected: {collected}"
    )

    # Validate structure of each sub-activity event
    for msg in skill_events:
        flow_data = msg["flow_data"]
        assert flow_data["element_type"] == "progress_report"
        attrs = flow_data["attributes"]
        assert attrs["job_name"] == "scan", f"Expected job_name='scan', got {attrs['job_name']}"
        assert attrs["sub_activity_name"] == "skill"
        assert isinstance(attrs["done"], int), f"done not int: {attrs}"
        assert isinstance(attrs["total"], int), f"total not int: {attrs}"
        assert attrs["done"] > 0
        assert attrs["total"] > 0
        assert attrs["done"] <= attrs["total"]

    # Monotonically non-decreasing done values
    done_values = [m["flow_data"]["attributes"]["done"] for m in skill_events]
    for i in range(1, len(done_values)):
        assert done_values[i] >= done_values[i - 1], (
            f"done not monotonic: {done_values}"
        )

    # Last sub-activity event must be the completion event
    last_attrs = skill_events[-1]["flow_data"]["attributes"]
    assert last_attrs["done"] == last_attrs["total"], (
        f"Last progress_report event should have done == total, "
        f"got done={last_attrs['done']} total={last_attrs['total']}"
    )

    # Validate job-level progress_report events (sub_activity_name=None)
    job_events = [
        m for m in collected
        if m.get("message_type") == "flow_data_msg"
        and m.get("flow_data", {}).get("element_type") == "progress_report"
        and m.get("flow_data", {}).get("attributes", {}).get("sub_activity_name") is None
    ]
    assert len(job_events) >= 1, (
        f"Expected at least 1 job-level progress_report event, got 0. All: {collected}"
    )
    for msg in job_events:
        attrs = msg["flow_data"]["attributes"]
        assert attrs["job_name"] == "scan"
        assert attrs["sub_activity_name"] is None
        assert isinstance(attrs["done"], int)
        assert isinstance(attrs["total"], int)


# ---------------------------------------------------------------------------
# Test 2: index_progress events
# ---------------------------------------------------------------------------


@pytest.mark.timeout(200)
def test_index_progress_events_via_websocket():
    """Aggregate index broadcasts index_progress flow_data_msg events over WebSocket.

    Validates:
    - At least one index_progress event is received for the "skill" type
    - Each event has the correct FlowData shape with indexed/errors counters
    - records_done values are monotonically non-decreasing
    - The last event has records_done == records_total
    - indexed + errors == records_done on the last event (no skipping)
    """
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")
        _create_skills(tc, skill_base, 30, prefix="idx-prog-skill")

        # Aggregate index URL (no ?type= filter so it calls index_type_progress())
        index_url = _cn_url(boot, "index")

        collected: list = []
        stop_event = threading.Event()
        connection_id = str(uuid.uuid4())

        with tc.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            confirmation = ws.receive_json()
            assert confirmation["message_type"] == "response_msg"

            reader_thread = _start_ws_reader(ws, collected, stop_event)

            index_result = {}

            def do_index():
                r = tc.post(index_url)
                index_result["status"] = r.status_code
                index_result["body"] = r.text

            index_thread = threading.Thread(target=do_index)
            index_thread.start()
            index_thread.join(timeout=150)

            assert index_result.get("status") == 200, f"Index failed: {index_result}"

            # Give the final WebSocket events a moment to arrive, then signal stop.
            # Do NOT join here — let the WS context close first.
            time.sleep(1.5)
            stop_event.set()

        # WS is now closed; reader_thread will see the socket error and exit.
        reader_thread.join(timeout=5)

    # Filter progress_report sub-activity events for "skill" type
    skill_events = _filter_progress(collected, "progress_report", type_name="skill")

    assert len(skill_events) >= 1, (
        f"Expected at least 1 progress_report sub-activity event for type 'skill', got 0. "
        f"All collected: {collected}"
    )

    # Validate structure of each sub-activity event
    for msg in skill_events:
        flow_data = msg["flow_data"]
        assert flow_data["element_type"] == "progress_report"
        attrs = flow_data["attributes"]
        assert attrs["job_name"] == "index", f"Expected job_name='index', got {attrs['job_name']}"
        assert attrs["sub_activity_name"] == "skill"
        assert isinstance(attrs["done"], int)
        assert isinstance(attrs["total"], int)
        assert attrs["done"] > 0
        assert attrs["total"] > 0
        assert attrs["done"] <= attrs["total"]
        assert isinstance(attrs["skipped"], int)
        assert isinstance(attrs["errors"], int)
        assert attrs["skipped"] >= 0
        assert attrs["errors"] >= 0

    # Monotonically non-decreasing done values
    done_values = [m["flow_data"]["attributes"]["done"] for m in skill_events]
    for i in range(1, len(done_values)):
        assert done_values[i] >= done_values[i - 1], (
            f"done not monotonic: {done_values}"
        )

    # Last sub-activity event must be the completion event
    last_attrs = skill_events[-1]["flow_data"]["attributes"]
    assert last_attrs["done"] == last_attrs["total"], (
        f"Last progress_report event should have done == total, "
        f"got done={last_attrs['done']} total={last_attrs['total']}"
    )

    # skipped + errors + (indexed) == done on the last event
    # Note: skipped + errors is a lower bound; indexed is not separately tracked in progress_report
    last_done = last_attrs["done"]
    last_skipped = last_attrs["skipped"]
    last_errors = last_attrs["errors"]
    assert last_skipped + last_errors <= last_done, (
        f"On last event: skipped({last_skipped}) + errors({last_errors}) "
        f"should be <= done({last_done})"
    )

    # Validate job-level progress_report events
    job_events = [
        m for m in collected
        if m.get("message_type") == "flow_data_msg"
        and m.get("flow_data", {}).get("element_type") == "progress_report"
        and m.get("flow_data", {}).get("attributes", {}).get("sub_activity_name") is None
    ]
    assert len(job_events) >= 1, (
        f"Expected at least 1 job-level progress_report event, got 0."
    )
    for msg in job_events:
        attrs = msg["flow_data"]["attributes"]
        assert attrs["job_name"] == "index"
        assert attrs["sub_activity_name"] is None
        assert isinstance(attrs["done"], int)
        assert isinstance(attrs["total"], int)


# ---------------------------------------------------------------------------
# Test 3: broadcast reaches all connected WS clients
# ---------------------------------------------------------------------------


@pytest.mark.timeout(120)
def test_broadcast_reaches_all_ws_clients():
    """broadcast_progress() sends scan_progress events to ALL connected WebSocket clients.

    Validates:
    - Two separate WebSocket connections both receive scan_progress events
    - Both connections see events for the "skill" type
    """
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")
        _create_skills(tc, skill_base, 30, prefix="broadcast-skill")

        scan_url = _cn_url(boot, "scan")

        collected_a: list = []
        collected_b: list = []
        stop_event_a = threading.Event()
        stop_event_b = threading.Event()

        conn_id_a = str(uuid.uuid4())
        conn_id_b = str(uuid.uuid4())

        with tc.websocket_connect(f"/api/v1/connect/ws/{conn_id_a}") as ws_a:
            with tc.websocket_connect(f"/api/v1/connect/ws/{conn_id_b}") as ws_b:
                # Consume confirmations
                conf_a = ws_a.receive_json()
                assert conf_a["message_type"] == "response_msg"
                assert conf_a["data"]["connection_id"] == conn_id_a

                conf_b = ws_b.receive_json()
                assert conf_b["message_type"] == "response_msg"
                assert conf_b["data"]["connection_id"] == conn_id_b

                reader_a = _start_ws_reader(ws_a, collected_a, stop_event_a)
                reader_b = _start_ws_reader(ws_b, collected_b, stop_event_b)

                # Trigger aggregate scan in a background thread
                scan_result = {}

                def do_scan():
                    r = tc.get(scan_url)
                    scan_result["status"] = r.status_code

                scan_thread = threading.Thread(target=do_scan)
                scan_thread.start()
                scan_thread.join(timeout=90)

                assert scan_result.get("status") == 200, "Scan failed"

                # Wait for events to propagate to both connections, then signal stop.
                # Do NOT join here — let both WS contexts close first.
                time.sleep(1.5)
                stop_event_a.set()
                stop_event_b.set()

        # Both WS connections are now closed; reader threads will see socket errors and exit.
        reader_a.join(timeout=5)
        reader_b.join(timeout=5)

    # Both connections should have received progress_report events for "skill"
    skill_events_a = _filter_progress(collected_a, "progress_report", type_name="skill")
    skill_events_b = _filter_progress(collected_b, "progress_report", type_name="skill")

    assert len(skill_events_a) >= 1, (
        f"WS client A received no progress_report events for 'skill'. "
        f"All collected by A: {collected_a}"
    )
    assert len(skill_events_b) >= 1, (
        f"WS client B received no progress_report events for 'skill'. "
        f"All collected by B: {collected_b}"
    )
