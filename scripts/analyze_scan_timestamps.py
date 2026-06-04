"""
Analyze inter-event gaps in progress_report WS events during aggregate scan.

Runs with 30 skill records (matching the long test), collects all progress_report
events, and prints a gap report to identify any "stuck between items" delays.
"""
from __future__ import annotations

import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Make sure repo root is on path
sys.path.insert(0, str(Path(__file__).parent.parent))

from flow_sdk.fs_store import get_default_records_root, set_default_records_root
from flow_sdk.server.app import app
from starlette.testclient import TestClient

import tempfile

N_RECORDS = 30


def _bootstrap(tc):
    resp = tc.get("/api/v1/graph/bootstrap")
    assert resp.status_code == 200
    return resp.json()


def _cn_url(boot, sub):
    cn_id = boot["data"]["default_compute_node"]["id"]
    return f"/api/v1/graph/compute_node/{cn_id}/fs-records/{sub}"


def run_analysis():
    with tempfile.TemporaryDirectory() as tmp:
        original = get_default_records_root()
        set_default_records_root(Path(tmp))
        try:
            _run(tmp)
        finally:
            set_default_records_root(original)


def _run(tmp):
    with TestClient(app) as tc:
        boot = _bootstrap(tc)
        skill_base = _cn_url(boot, "skill")

        print(f"Creating {N_RECORDS} skill records...")
        for i in range(N_RECORDS):
            resp = tc.post(skill_base, json={"name": f"ts-skill-{i}", "description": f"desc {i}"})
            assert resp.status_code == 200, resp.text

        scan_url = _cn_url(boot, "scan")
        collected: list = []
        stop_event = threading.Event()
        connection_id = str(uuid.uuid4())

        with tc.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            confirmation = ws.receive_json()
            assert confirmation["message_type"] == "response_msg"

            def reader():
                while not stop_event.is_set():
                    try:
                        msg = ws.receive_json()
                        collected.append(msg)
                    except Exception:
                        break

            reader_thread = threading.Thread(target=reader, daemon=True)
            reader_thread.start()

            result = {}

            def do_scan():
                r = tc.get(f"{scan_url}?trigger=manual")
                result["status"] = r.status_code
                result["body"] = r.text

            print("Starting aggregate scan...")
            t0 = time.monotonic()
            scan_thread = threading.Thread(target=do_scan)
            scan_thread.start()
            scan_thread.join(timeout=120)
            elapsed = time.monotonic() - t0

            assert result.get("status") == 200, f"Scan failed: {result}"
            print(f"Scan completed in {elapsed:.2f}s")

            time.sleep(1.0)
            stop_event.set()
            reader_thread.join(timeout=3)

    # Extract progress_report events
    events = [
        m for m in collected
        if m.get("message_type") == "flow_data_msg"
        and m.get("flow_data", {}).get("element_type") == "progress_report"
    ]
    print(f"\nTotal progress_report events received: {len(events)}")

    if not events:
        print("ERROR: No progress_report events received!")
        return

    # Parse timestamps
    records = []
    for m in events:
        attrs = m["flow_data"]["attributes"]
        ts_str = attrs.get("ts")
        if not ts_str:
            continue
        ts = datetime.fromisoformat(ts_str)
        records.append({
            "ts": ts,
            "job": attrs.get("job_name"),
            "sub": attrs.get("sub_activity_name"),
            "done": attrs.get("done"),
            "total": attrs.get("total"),
        })

    records.sort(key=lambda r: r["ts"])

    # Compute gaps
    gaps_ms = []
    for i in range(1, len(records)):
        gap = (records[i]["ts"] - records[i-1]["ts"]).total_seconds() * 1000
        gaps_ms.append(gap)

    if not gaps_ms:
        print("Only 1 event — can't compute gaps.")
        return

    # Stats
    avg = sum(gaps_ms) / len(gaps_ms)
    max_gap = max(gaps_ms)
    max_idx = gaps_ms.index(max_gap)
    median = sorted(gaps_ms)[len(gaps_ms) // 2]

    print(f"\n{'='*60}")
    print(f"  Gap Analysis ({len(records)} events, {len(gaps_ms)} gaps)")
    print(f"{'='*60}")
    print(f"  avg:    {avg:.1f}ms")
    print(f"  median: {median:.1f}ms")
    print(f"  max:    {max_gap:.1f}ms")
    print(f"{'='*60}")

    # Show the top 5 biggest gaps
    indexed_gaps = sorted(enumerate(gaps_ms), key=lambda x: -x[1])[:5]
    print(f"\n  Top 5 largest gaps:")
    for rank, (idx, gap) in enumerate(indexed_gaps, 1):
        before = records[idx]
        after = records[idx + 1]
        print(f"  #{rank}  {gap:.1f}ms   between:")
        print(f"         [{before['job']}] sub={before['sub']} done={before['done']}/{before['total']}")
        print(f"         [{after['job']}] sub={after['sub']}  done={after['done']}/{after['total']}")

    # Show all events with their inter-event gaps
    print(f"\n  Full event stream:")
    print(f"  {'#':>4}  {'gap_ms':>8}  {'job':<6}  {'sub_activity':<20}  {'done':>5}/{'{total}':>5}")
    print(f"  {'-'*70}")
    for i, rec in enumerate(records):
        gap_str = f"{gaps_ms[i-1]:>7.1f}ms" if i > 0 else "    (first)"
        sub = rec["sub"] or "(job-level)"
        print(f"  {i:>4}  {gap_str}  {rec['job']:<6}  {sub:<20}  {rec['done']:>5}/{rec['total']:>5}")

    # Flag gaps > 500ms as potential stalls
    stalls = [(i, g) for i, g in enumerate(gaps_ms) if g > 500]
    if stalls:
        print(f"\n  ⚠️  STALLS (gap > 500ms): {len(stalls)}")
        for idx, gap in stalls:
            before = records[idx]
            after = records[idx + 1]
            print(f"     {gap:.0f}ms  {before['sub']} → {after['sub']}")
    else:
        print(f"\n  ✓  No stalls > 500ms detected")


if __name__ == "__main__":
    run_analysis()
