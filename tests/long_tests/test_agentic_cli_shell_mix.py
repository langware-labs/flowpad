"""test_agentic_cli_shell_mix

Backend test that mirrors the useActiveTerminals React hook merge logic.

Setup entities:
  shell_A  - plain, idle, tab_order=0                    → plain tab, not disabled
  shell_B  - idle, tab_order=1, linked to a              → claude tab, not disabled
             RUNNING AgenticProcess (process_B)
  shell_C  - closed, tab_order=2                         → deleted by close(), not in tabs
  shell_E  - idle, tab_order=3, linked to a              → plain tab, not disabled
             TERMINATED AgenticProcess (process_E)         (terminated procs are not active)

Operations tested:
  query   - GET /api/v1/graph/shell + GET /api/v1/graph/agentic_process
  merge   - Python port of useActiveTerminals logic
  start   - transition shell_A to running (PUT status + pty_pid)
  stop    - close shell_B (POST /close); verify entity deleted + excluded from
            list-shells
"""

import pytest

from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

from flow_sdk.responses.response import ApiResponse

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Statuses that make a process "not active" (mirroring useActiveTerminals)
_TERMINAL_STATUSES = {"terminated", "complete"}


# ---------------------------------------------------------------------------
# Merge helper (Python port of useActiveTerminals)
# ---------------------------------------------------------------------------

def _merge_tabs(shells: list[dict], processes: list[dict]) -> list[dict]:
    """Merge Shell + AgenticProcess entity dicts into sorted terminal tab list.

    Mirrors the logic in ui/src/hooks/useActiveTerminals.ts.
    Closed shells are deleted from the DB, so all shells in the query result
    are visible tabs (closed/error ones are shown as disabled).
    """
    active_procs = [
        p for p in processes
        if p.get("status") not in _TERMINAL_STATUSES
    ]

    # shell_id → process
    shell_to_proc = {
        p["shell_id"]: p
        for p in active_procs
        if p.get("shell_id")
    }

    tabs = []
    for shell in shells:
        proc = shell_to_proc.get(shell["id"])
        is_dead = shell.get("status") in ("closed", "error")
        tabs.append(
            {
                "shell_id": shell["id"],
                "tab_order": shell.get("tab_order", 0),
                "type": "claude" if proc else "plain",
                "process": proc,
                "is_disabled": is_dead,
                "status": shell.get("status"),
            }
        )

    tabs.sort(key=lambda t: t["tab_order"])
    return tabs


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cn_id(bootstrap_json: dict) -> str:
    return bootstrap_json["data"]["default_compute_node"]["id"]


async def _create_shell(client, name: str, tab_order: int, cn_id: str,
                        status: str = "idle") -> str:
    r = await client.post(
        "/api/v1/graph/shell",
        json={
            "name": name,
            "tab_order": tab_order,
            "status": status,
            "compute_node_id": cn_id,
        },
    )
    assert r.status_code == 200, r.text
    return ApiResponse(**r.json()).data["id"]


async def _create_process(client, cn_id: str,
                          shell_id: str, state_status: str) -> str:
    r = await client.post(
        "/api/v1/graph/agentic_process",
        json={
            "compute_node_id": f"compute_node-{cn_id}",
            "context_data": {"compute_node_id": f"compute_node-{cn_id}"},
            "status": state_status,
            "shell_id": shell_id,
        },
    )
    assert r.status_code == 200, r.text
    return ApiResponse(**r.json()).data["id"]


async def _query_our(client, our_shell_ids: set, our_proc_ids: set) -> tuple[list, list]:
    """Fetch all shells and processes, filter to the ones we created."""
    shells_r = await client.get("/api/v1/graph/shell")
    procs_r = await client.get("/api/v1/graph/agentic_process")
    assert shells_r.status_code == 200
    assert procs_r.status_code == 200

    shells = [s for s in ApiResponse(**shells_r.json()).data if s["id"] in our_shell_ids]
    procs = [p for p in ApiResponse(**procs_r.json()).data if p["id"] in our_proc_ids]
    return shells, procs


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_agentic_cli_shell_mix(bootstrapped_client):
    """
    Validates Shell + AgenticProcess tab merge logic, start, and stop transitions.
    """
    # ── Bootstrap ─────────────────────────────────────────────────────────────
    bs = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    assert bs.status_code == 200
    cn_id = _cn_id(bs.json())

    # ── Setup shells ──────────────────────────────────────────────────────────
    shell_A = await _create_shell(bootstrapped_client, "plain-A", 0, cn_id)
    shell_B = await _create_shell(bootstrapped_client, "claude-B", 1, cn_id)
    shell_C = await _create_shell(bootstrapped_client, "closed-C", 2, cn_id)
    shell_E = await _create_shell(bootstrapped_client, "terminated-E", 3, cn_id)

    # Close shell_C — this deletes the entity from the DB
    r = await bootstrapped_client.post(f"/api/v1/graph/shell/{shell_C}/close")
    assert ApiResponse(**r.json()).status == "SUCCESS"

    our_shell_ids = {shell_A, shell_B, shell_C, shell_E}

    # ── Setup processes ───────────────────────────────────────────────────────
    # process_B: RUNNING, linked to shell_B → active, makes shell_B a claude tab
    process_B = await _create_process(
        bootstrapped_client, cn_id, shell_B, "running"
    )
    # process_E: TERMINATED, linked to shell_E → filtered out, shell_E stays plain
    process_E = await _create_process(
        bootstrapped_client, cn_id, shell_E, "terminated"
    )
    our_proc_ids = {process_B, process_E}

    # ── Query ─────────────────────────────────────────────────────────────────
    shells, procs = await _query_our(bootstrapped_client, our_shell_ids, our_proc_ids)

    # shell_C was closed (deleted) so only A, B, E remain
    assert len(shells) == 3, f"Expected 3 shell entities (C deleted by close), got {len(shells)}"
    assert len(procs) == 2, f"Expected 2 process entities, got {len(procs)}"

    # ── Merge ─────────────────────────────────────────────────────────────────
    tabs = _merge_tabs(shells, procs)
    tab_by_shell = {t["shell_id"]: t for t in tabs}

    # A, B, E → 3 tabs (C was deleted)
    assert len(tabs) == 3, (
        f"Expected 3 tabs (C deleted by close), got {len(tabs)}: "
        f"{[t['shell_id'] for t in tabs]}"
    )

    # Correct sort order
    assert [t["shell_id"] for t in tabs] == [shell_A, shell_B, shell_E], (
        f"Tab order mismatch: {[t['shell_id'] for t in tabs]}"
    )

    # A: plain idle — not disabled
    assert tab_by_shell[shell_A]["type"] == "plain"
    assert tab_by_shell[shell_A]["is_disabled"] is False

    # B: claude tab (linked to RUNNING process) — not disabled
    assert tab_by_shell[shell_B]["type"] == "claude"
    assert tab_by_shell[shell_B]["is_disabled"] is False
    assert tab_by_shell[shell_B]["process"]["id"] == process_B

    # E: idle, but process is TERMINATED (not active) → plain, not disabled
    assert tab_by_shell[shell_E]["type"] == "plain"
    assert tab_by_shell[shell_E]["is_disabled"] is False

    # C should not appear in tabs (entity was deleted)
    assert shell_C not in tab_by_shell

    # ── Start: transition shell_A to running ─────────────────────────────────
    # Simulate what Shell.open() does: set status=running + pty_pid
    r = await bootstrapped_client.put(
        f"/api/v1/graph/shell/{shell_A}",
        json={"status": "running", "pty_pid": shell_A},
    )
    assert ApiResponse(**r.json()).status == "SUCCESS"

    # Re-query and merge
    shells2, procs2 = await _query_our(bootstrapped_client, our_shell_ids, our_proc_ids)
    tabs2 = _merge_tabs(shells2, procs2)
    tab_A_after = next(t for t in tabs2 if t["shell_id"] == shell_A)

    # running → not disabled (running is not 'closed' or 'error')
    assert tab_A_after["is_disabled"] is False
    assert tab_A_after["status"] == "running"

    # list-shells includes shell_A (running, pty_pid set, not closed/error)
    list_r = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/list-shells"
    )
    assert list_r.status_code == 200
    list_ids = {s["id"] for s in ApiResponse(**list_r.json()).data}
    assert shell_A in list_ids, "Running shell_A must appear in list-shells"

    # ── Stop: close shell_B ───────────────────────────────────────────────────
    r = await bootstrapped_client.post(f"/api/v1/graph/shell/{shell_B}/close")
    assert ApiResponse(**r.json()).status == "SUCCESS"

    # Re-query — shell_B should now be deleted
    shells3, procs3 = await _query_our(bootstrapped_client, our_shell_ids, our_proc_ids)
    tabs3 = _merge_tabs(shells3, procs3)
    shell_ids_in_tabs3 = {t["shell_id"] for t in tabs3}

    # shell_B was deleted by close(), so it must not appear in tabs
    assert shell_B not in shell_ids_in_tabs3, (
        "Closed shell_B should be deleted and not appear in tabs"
    )

    # list-shells must NOT include closed shell_B
    list_r2 = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/list-shells"
    )
    assert list_r2.status_code == 200
    list_ids2 = {s["id"] for s in ApiResponse(**list_r2.json()).data}
    assert shell_B not in list_ids2, "Closed shell_B must not appear in list-shells"
