"""Python half of the transport-switch gate contract (FLOWPAD-2105).

The frontend greys a `ViewToggle` segment, and declines the reconcile behind it,
on `surfaceTransportGate(...).blocked`. This file pins the BACKEND side of that
same question to the shared truth table in `test_fixtures/status_sets.json` —
the same rows the vitest `ui/tests/unit/transport-switch-gate-contract.test.ts`
iterates. Editing one side without the other breaks both.

The contract has two halves, and the second is an asymmetry worth stating
plainly rather than papering over:

* **`→cli`** goes through the `switch-mode` action, whose
  `_reject_if_turn_in_flight` 409s on `is_turn_busy`. The client gate is an
  exact mirror there — and it is a mirror of the *value*, not a reimplementation:
  the wire `busy` field IS `is_turn_busy(...)` computed here and serialized, so
  the TS `isBusy(p)` is `p.busy === true` and the two cannot disagree on logic.

* **`→interactive`** does NOT reach `switch_mode` from the UI at all.
  `switchMode(Interactive)` calls `start()` → the `open` action → `start_pty`,
  and that path carries no mid-turn guard. The server accepts a mid-turn open,
  so the client does not refuse one either — it mirrors the route rather than
  inventing policy, and `blocked == backend_refuses` on every row.

  That asymmetry is asserted below rather than assumed, so it cannot rot: if a
  guard is ever added to `open`, these tests fail until BOTH `backend_refuses`
  and `blocked` are flipped on those fixture rows.
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
    """For every row routed at `switch-mode`, the action's 409 and the client's
    `blocked` must be the same decision."""
    for row in cases:
        if row["backend_route"] != "switch-mode":
            continue
        proc = _proc(row)
        req = MagicMock()
        req.get_post_data = AsyncMock(return_value={"mode": "cli"})
        with (
            patch(
                "flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info",
                return_value=req,
            ),
            patch.object(AgenticProcess, "_enter_cli_mode", new=AsyncMock(return_value="entered")),
        ):
            result = await proc.switch_mode()

        refused = isinstance(result, ApiFailResponse) and result.status_code == 409
        assert refused is row["backend_refuses"], row["label"]
        # …and that is exactly what the client greys the segment on.
        assert refused is row["blocked"], f"client/server disagree: {row['label']}"


@pytest.mark.asyncio
async def test_the_open_route_has_no_mid_turn_guard(cases):
    """The asymmetry, asserted rather than assumed.

    `→terminal` reaches `start_pty` through the `open` action, which never calls
    `_reject_if_turn_in_flight`. A mid-turn `open` is therefore accepted by the
    backend — and the client, mirroring the route, does not refuse it either. If
    a guard is ever added there, this test fails and BOTH `backend_refuses` and
    `blocked` must be flipped on the `open` rows (and this docstring rewritten).
    """
    open_rows = [r for r in cases if r["backend_route"] == "open"]
    assert open_rows, "fixture must cover the ->terminal direction"

    for row in open_rows:
        assert row["backend_refuses"] is False, row["label"]
        # …and the client mirrors that rather than adding a refusal of its own.
        assert row["blocked"] is False, row["label"]

    mid_turn = [r for r in open_rows if r["busy"]]
    assert mid_turn, "fixture must cover a mid-turn ->terminal click"
    for row in mid_turn:
        proc = _proc(row)
        # The guard EXISTS and would fire on this very state — it simply is not
        # on the route the UI takes. That is the whole asymmetry, in one line.
        assert proc._reject_if_turn_in_flight() is not None, row["label"]


@pytest.mark.asyncio
async def test_open_action_does_not_consult_the_turn_guard(use_tmp_records_root):
    """Structural companion to the row assertions above: drive the real `open`
    action on a busy process and prove it reaches `start_pty` regardless."""
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
