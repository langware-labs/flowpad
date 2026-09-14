"""Python half of the transport-switch gate contract (FLOWPAD-2105/2130).

Pins the BACKEND side of what the client greys on to the shared truth table in
`test_fixtures/status_sets.json` — the same rows the vitest
`ui/tests/unit/transport-switch-gate-contract.test.ts` iterates, so editing one
side without the other breaks both.

Both directions go through `switch-mode`, whose `_reject_if_turn_in_flight` 409s
on `is_turn_busy` — the same value the wire `busy` field carries, so the client
mirrors it rather than reimplementing it. That symmetry is the FLOWPAD-2130 fix:
`switchMode(Interactive)` used to call the unguarded `open`, so a →terminal click
during a live headless turn spawned a PTY onto that turn's own session and lost
it. `open` itself stays unguarded (FLOWPAD-2117 — loaders, watchdog and recovery
depend on that); what changed is that no switch is routed at it any more.
"""
import json
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
from flow_sdk.fs_store.record_paths import (
    get_default_records_data_root,
    get_default_records_root,
    set_default_records_data_root,
    set_default_records_root,
)
from flow_sdk.responses.response import ApiFailResponse

FIXTURE_PATH = Path(__file__).resolve().parents[2] / "test_fixtures" / "status_sets.json"


@pytest.fixture
def cases() -> list[dict]:
    rows = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["transport_switch_cases"]
    assert rows, "fixture must carry the shared transport-switch truth table"
    return rows


@pytest.fixture(autouse=True)
def use_tmp_records_root(tmp_path):
    orig_root = get_default_records_root()
    orig_data_root = get_default_records_data_root()
    set_default_records_root(tmp_path)
    set_default_records_data_root(tmp_path)
    yield tmp_path
    set_default_records_root(orig_root)
    set_default_records_data_root(orig_data_root)


def _proc(row: dict) -> AgenticProcess:
    """A process carrying the row's state. `busy` is not a stored field — it is
    derived by `is_turn_busy` — so the row's `busy` is applied by forcing the
    turn-in-flight marker the predicate reads."""
    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        status=row["status"],
        pty_mode=row["pty_mode"],
        visible=row["pty_mode"],
        session_id=row["session_id"],
    )
    proc._turn_in_flight = row["busy"]
    return proc


def test_wire_busy_is_the_backend_predicate_itself(cases):
    """The client does not reimplement the refusal — it reads this answer.

    TS `isBusy(p)` is literally `p.busy === true`, and the wire `busy` is
    `is_turn_busy(...)` computed here. So the only way the two can disagree is
    staleness of the snapshot, never divergent logic. This asserts the rows the
    fixture claims are busy really are busy by the backend's own predicate.
    """
    for row in cases:
        proc = _proc(row)
        assert is_turn_busy(proc) is row["busy"], row["label"]


@pytest.mark.asyncio
async def test_switch_mode_409s_exactly_when_the_client_blocks(cases):
    """For every switching row — BOTH directions — the action's 409 and the
    client's `blocked` are the same decision. The row's own transport picks the
    direction. Before FLOWPAD-2130 only the `cli` half of this loop existed,
    because the other half never reached this action.
    """
    exercised = {"interactive": 0, "cli": 0}
    for row in cases:
        if row["backend_route"] != "switch-mode":
            continue
        mode = "cli" if row["pty_mode"] else "interactive"
        proc = _proc(row)
        req = MagicMock()
        req.get_post_data = AsyncMock(return_value={"mode": mode})
        req.request_connection_id = None
        with (
            patch(
                "flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info",
                return_value=req,
            ),
            patch.object(AgenticProcess, "_enter_cli_mode", new=AsyncMock(return_value="entered")),
            patch.object(AgenticProcess, "start_pty", new=AsyncMock(return_value="opened")),
        ):
            result = await proc.switch_mode()

        refused = isinstance(result, ApiFailResponse) and result.status_code == 409
        assert refused is row["backend_refuses"], f"{mode}: {row['label']}"
        # …and that is exactly what the client greys the segment on.
        assert refused is row["blocked"], f"client/server disagree: {row['label']}"
        exercised[mode] += 1

    assert exercised["interactive"], "fixture must cover the ->terminal direction"
    assert exercised["cli"], "fixture must cover the ->chat direction"


@pytest.mark.asyncio
async def test_interactive_switch_409s_mid_turn(use_tmp_records_root):
    """The FLOWPAD-2130 fix, at the action rather than through a row: a mid-turn
    `→interactive` is refused BEFORE anything spawns, because the whole failure
    was a second worker landing on the live turn's own session.
    """
    proc = AgenticProcess(id=str(uuid.uuid4()), status="running", pty_mode=False, visible=False)
    proc._turn_in_flight = True
    assert is_turn_busy(proc) is True

    req = MagicMock()
    req.get_post_data = AsyncMock(return_value={"mode": "interactive"})
    req.request_connection_id = None
    with (
        patch(
            "flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info",
            return_value=req,
        ),
        patch.object(AgenticProcess, "start_pty", new=AsyncMock(return_value="opened")) as start_pty,
    ):
        result = await proc.switch_mode()

    assert isinstance(result, ApiFailResponse) and result.status_code == 409
    start_pty.assert_not_awaited()


def test_transport_switches_never_route_through_open(cases):
    """`open` is still unguarded, so no transport switch may be routed at it.
    Guarding `open` itself is FLOWPAD-2117 and deliberately not done here —
    loaders, the watchdog and auto-recovery all call it unconditionally.
    """
    assert not [r for r in cases if r["backend_route"] == "open"], (
        "a transport switch routed at `open` bypasses _reject_if_turn_in_flight"
    )


@pytest.mark.asyncio
async def test_open_action_still_has_no_mid_turn_guard(use_tmp_records_root):
    """Pins the deliberate remainder (FLOWPAD-2117) so nobody "fixes" it here:
    `open` is the internal PTY entry point and a busy refusal there is a wider
    decision. If that changes deliberately, delete this test.
    """
    proc = AgenticProcess(id=str(uuid.uuid4()), status="running", pty_mode=False, visible=False)
    proc._turn_in_flight = True
    assert is_turn_busy(proc) is True

    req = MagicMock()
    req.get_post_data = AsyncMock(return_value={"visible": True, "retry": True})
    req.request_connection_id = None
    with (
        patch(
            "flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info",
            return_value=req,
        ),
        patch.object(AgenticProcess, "start_pty", new=AsyncMock(return_value="opened")) as start_pty,
    ):
        result = await proc._http_open()

    assert result == "opened", "the open action must not 409 mid-turn — it has no such guard"
    start_pty.assert_awaited_once()


def test_client_refuses_exactly_what_the_server_refuses(cases):
    """Equality, not an inequality — in both directions.

    A client STRICTER than the server greys a button the backend would have
    honoured, which tells the user something untrue about the system. A client
    LOOSER sends a call that 409s. The gate mirrors the route and nothing else.
    """
    for row in cases:
        assert row["blocked"] is row["backend_refuses"], row["label"]


def test_no_call_means_no_gate(cases):
    """A pick that issues no lifecycle call must never be greyed. chat⇄vibe and
    re-picking the current transport are exactly that, and they must stay live
    through the busiest turn — reading the conversation is not a lifecycle
    action."""
    for row in cases:
        if not row["needs_switch"]:
            assert row["blocked"] is False, row["label"]
            assert row["backend_refuses"] is False, row["label"]
