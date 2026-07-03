"""Unit tests for the two-axis status model on AgenticProcess.

Covers:
- ``ProcessStatus`` (lifecycle) + ``WorkerStatus`` (worker) enum definitions
- set literals (running/terminal) matching the shared fixture
- ``is_ready_for_input`` predicate truth-table
- ``_tail_status`` mapping for every canonical WorkerStatus value + UNKNOWN fallback
- regression guards: ``is_active`` and ``waiting_for_prompt`` are gone
- lifecycle transitions via the public writer surface

See ``test_fixtures/status_sets.json`` — the single source of truth for the set
literals, shared with the TS vitest ``set parity`` test.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess, ProcessStatus, WorkerStatus
from flow_sdk.builtin.agentic_process.status_predicates import (
    get_worker_mode,
    is_ready_for_input,
    WorkerMode,
)
from flow_sdk.builtin.worker_status import (
    _IGNORED_TYPES,
    _RUNNING_STATUSES,
    _TAIL_BYTES,
    _TERMINAL_STATUSES,
    _tail_status,
)


FIXTURE_PATH = Path(__file__).parent.parent.parent / "test_fixtures" / "status_sets.json"


@pytest.fixture(scope="module")
def status_fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text())


# ── Set parity (against shared fixture) ──────────────────────────────────────


def test_running_set_matches_spec(status_fixture):
    """Python ``_RUNNING_STATUSES`` must equal the shared fixture literal."""
    expected = {WorkerStatus(v) for v in status_fixture["worker_running"]}
    assert _RUNNING_STATUSES == expected


def test_terminal_set_matches_spec(status_fixture):
    """Python ``_TERMINAL_STATUSES`` must equal the shared fixture literal."""
    expected = {WorkerStatus(v) for v in status_fixture["worker_terminal"]}
    assert _TERMINAL_STATUSES == expected


def test_error_set_matches_spec(status_fixture):
    """Python ``_ERROR_STATUSES`` must equal the shared fixture literal
    (``worker_execution_error``), kept in parity with the TS ``ERROR_WORKER_STATUSES``."""
    from flow_sdk.builtin.worker_status import _ERROR_STATUSES

    expected = {WorkerStatus(v) for v in status_fixture["worker_execution_error"]}
    assert _ERROR_STATUSES == expected


def test_busy_worker_set_matches_spec(status_fixture):
    """Python ``_BUSY_WORKER_STATUSES`` (the raw worker states that make a turn
    ``busy``) must equal the shared fixture ``worker_busy`` literal — the same
    key the TS parity describe asserts against ``WORKER_BUSY_STATUSES``. Pins the
    busy predicate to one source of truth: ``{initializing, working, thinking,
    tool_call, tool_running}`` (api_error excluded — it maps to a *ready* process
    status)."""
    from flow_sdk.builtin.agentic_process.status_predicates import _BUSY_WORKER_STATUSES

    expected = {WorkerStatus(v) for v in status_fixture["worker_busy"]}
    assert _BUSY_WORKER_STATUSES == expected


def test_process_running_wire_set_matches_spec(status_fixture):
    """``process_lifecycle.is_running`` must accept exactly the fixture
    ``process_running_wire`` literal (``{starting, running, ready, busy,
    stopping}``) — it classifies serialized payloads, so it accepts both the
    stored ``running`` and its wire projections ``ready``/``busy``. Py side of the
    TS ``isProcessRunning`` parity test."""
    from flow_sdk.builtin.process_lifecycle import is_running as is_process_running

    expected = {ProcessStatus(v) for v in status_fixture["process_running_wire"]}
    actual = {s for s in ProcessStatus if is_process_running(s)}
    assert actual == expected


def test_process_stored_running_values(status_fixture):
    """The stored-FSM live values (``process_stored_running``) are a subset of the
    wire live set — the projection only ADDS ready/busy, never removes."""
    stored = {ProcessStatus(v) for v in status_fixture["process_stored_running"]}
    wire = {ProcessStatus(v) for v in status_fixture["process_running_wire"]}
    assert stored < wire
    assert ProcessStatus.READY not in stored and ProcessStatus.BUSY not in stored


def test_process_startable_set_matches_spec(status_fixture):
    """``process_lifecycle.is_startable`` must accept exactly the fixture
    ``process_startable`` literal (``{new, stopped, failed}``) — the py side of
    the TS ``process_startable fixture matches isProcessStartable`` parity test."""
    from flow_sdk.builtin.process_lifecycle import is_startable as is_process_startable

    expected = {ProcessStatus(v) for v in status_fixture["process_startable"]}
    actual = {s for s in ProcessStatus if is_process_startable(s)}
    assert actual == expected


# ── classify_execution_mode truth table ──────────────────────────────────────


def test_classify_execution_mode_truth_table():
    from flow_sdk.builtin.worker_status import ExecutionMode, classify_execution_mode

    # Not live → None.
    for s in ("new", "stopping", "stopped", "failed"):
        assert classify_execution_mode(status=s, worker_status=None, pty_mode=True) is None

    # Live PTY / CLI split — keyed on the transport ``pty_mode``, not ``visible``.
    for s in ("running", "starting"):
        assert (
            classify_execution_mode(status=s, worker_status=None, pty_mode=True)
            == ExecutionMode.INTERACTIVE
        )
        assert (
            classify_execution_mode(status=s, worker_status=None, pty_mode=False)
            == ExecutionMode.BACKGROUND
        )

    # Error worker_status wins over transport, for both PTY and CLI.
    for w in ("error", "api_timeout", "inactive"):
        assert (
            classify_execution_mode(status="running", worker_status=w, pty_mode=True)
            == ExecutionMode.ERROR
        )
        assert (
            classify_execution_mode(status="running", worker_status=w, pty_mode=False)
            == ExecutionMode.ERROR
        )

    # Dead PTY pid → Error; CLI without pid liveness stays Background.
    assert (
        classify_execution_mode(status="running", worker_status=None, pty_mode=True, pid_alive=False)
        == ExecutionMode.ERROR
    )
    assert (
        classify_execution_mode(status="running", worker_status=None, pty_mode=False)
        == ExecutionMode.BACKGROUND
    )


def test_classify_execution_mode_hidden_live_pty_is_interactive():
    """A hidden live PTY (visible=False but pty_mode=True) is a PTY worker →
    INTERACTIVE, NOT the headless BACKGROUND bucket. Pins the transport-keyed
    contract that the old ``visible``-keyed classifier got wrong."""
    from flow_sdk.builtin.worker_status import ExecutionMode, classify_execution_mode

    assert (
        classify_execution_mode(status="running", worker_status=None, pty_mode=True)
        == ExecutionMode.INTERACTIVE
    )
    # And a dead-PID hidden PTY still surfaces as Error (rule 2 keys on pty_mode).
    assert (
        classify_execution_mode(status="running", worker_status=None, pty_mode=True, pid_alive=False)
        == ExecutionMode.ERROR
    )


# ── ProcessStatus enum shape ─────────────────────────────────────────────────


def test_process_status_values():
    assert ProcessStatus.NEW.value == "new"
    assert ProcessStatus.STARTING.value == "starting"
    assert ProcessStatus.RUNNING.value == "running"
    assert ProcessStatus.STOPPING.value == "stopping"
    assert ProcessStatus.STOPPED.value == "stopped"
    assert ProcessStatus.FAILED.value == "failed"
    # Wire-only logical projections of RUNNING.
    assert ProcessStatus.READY.value == "ready"
    assert ProcessStatus.BUSY.value == "busy"


def test_process_status_no_live():
    """``LIVE`` was renamed to ``RUNNING`` — the old name must not resolve."""
    with pytest.raises(AttributeError):
        _ = ProcessStatus.LIVE  # type: ignore[attr-defined]


# ── WorkerStatus enum shape ──────────────────────────────────────────────────


EXPECTED_WORKER_VALUES = {
    "initializing",
    "idle",
    "complete",
    "error",
    "interrupted",
    "inactive",
    "working",
    "thinking",
    "tool_call",
    "tool_running",
    "api_error",
    "api_timeout",
    "pending_user",
    "unknown",
}


def test_worker_status_values_match_spec():
    assert {s.value for s in WorkerStatus} == EXPECTED_WORKER_VALUES


@pytest.mark.parametrize("removed_name", ["NEW", "INIT", "EMPTY", "PAUSED", "STEPPING"])
def test_worker_status_removed_values(removed_name):
    """Values removed in the consolidation must not resolve."""
    with pytest.raises(AttributeError):
        _ = getattr(WorkerStatus, removed_name)


def test_worker_status_new_values_present():
    """Both rename results must be directly accessible."""
    assert WorkerStatus.INITIALIZING.value == "initializing"
    assert WorkerStatus.UNKNOWN.value == "unknown"


# ── _tail_status mapping ─────────────────────────────────────────────────────


def _write_jsonl(path: Path, entries: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(e) for e in entries))


def test_tail_status_missing_file_is_initializing(tmp_path: Path):
    """No JSONL file yet → worker is initialising."""
    assert _tail_status(tmp_path / "nope.jsonl") == WorkerStatus.INITIALIZING


def test_tail_status_empty_file_is_initializing(tmp_path: Path):
    """Empty JSONL (no parseable lines) → initialising."""
    f = tmp_path / "session.jsonl"
    f.write_text("")
    assert _tail_status(f) == WorkerStatus.INITIALIZING


def test_tail_status_end_turn_is_complete(tmp_path: Path):
    """Assistant stop_reason=end_turn → COMPLETE."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "end_turn", "content": []}},
    ])
    assert _tail_status(f) == WorkerStatus.COMPLETE


def test_tail_status_stop_sequence_is_error(tmp_path: Path):
    """Assistant stop_reason=stop_sequence → ERROR."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "stop_sequence", "content": []}},
    ])
    assert _tail_status(f) == WorkerStatus.ERROR


def test_tail_status_thinking(tmp_path: Path):
    """Active file + assistant with no stop_reason → THINKING."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": None, "content": []}},
    ])
    os.utime(f, None)
    assert _tail_status(f) == WorkerStatus.THINKING


def test_tail_status_tool_call(tmp_path: Path):
    """Active file + stop_reason=tool_use → TOOL_CALL."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "tool_use", "content": []}},
    ])
    os.utime(f, None)
    assert _tail_status(f) == WorkerStatus.TOOL_CALL


def test_tail_status_pending_user_question_is_pending_user(tmp_path: Path):
    """An unanswered blocking user-input tool (AskUserQuestion / ExitPlanMode)
    is PENDING_USER ("Idle"), NOT TOOL_CALL — Claude has yielded to
    the user and is idle awaiting their answer, so the spinner must not spin.
    """
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "toolu_ask1", "name": "AskUserQuestion", "input": {}},
        ]}},
    ])
    os.utime(f, None)
    assert _tail_status(f) == WorkerStatus.PENDING_USER


def test_tail_status_pending_user_question_survives_trailing_meta(tmp_path: Path):
    """Trailing ``last-prompt``/``mode``/``permission-mode`` markers after the
    asking turn must not mask the pending question (the real regressed case)."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "toolu_ask2", "name": "AskUserQuestion", "input": {}},
        ]}},
        {"type": "last-prompt"},
        {"type": "mode"},
        {"type": "permission-mode"},
    ])
    os.utime(f, None)
    assert _tail_status(f) == WorkerStatus.PENDING_USER


def test_tail_status_answered_user_question_falls_through(tmp_path: Path):
    """Once the user answers, the ``tool_result`` (paired by ``tool_use_id``)
    resolves the question and the tail classifies normally (here → COMPLETE)."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "toolu_ask3", "name": "AskUserQuestion", "input": {}},
        ]}},
        {"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_ask3", "content": "ok"},
        ]}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "end_turn", "content": []}},
    ])
    os.utime(f, None)
    assert _tail_status(f) == WorkerStatus.COMPLETE


def test_tail_status_tool_running(tmp_path: Path):
    """Active file + last entry type=progress → TOOL_RUNNING."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "progress", "message": {"phase": "tool"}},
    ])
    os.utime(f, None)
    assert _tail_status(f) == WorkerStatus.TOOL_RUNNING


def test_tail_status_last_prompt_after_end_turn_is_complete(tmp_path: Path):
    """``last-prompt`` idle marker trailing a genuine ``end_turn`` → COMPLETE.

    The normal end-of-turn shape: the model finishes (``stop_reason=end_turn``)
    and Claude appends a ``last-prompt`` ack. This must stay terminal.
    """
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "end_turn", "content": []}},
        {"type": "last-prompt"},
    ])
    os.utime(f, None)
    assert _tail_status(f) == WorkerStatus.COMPLETE


def test_tail_status_last_prompt_with_end_turn_past_tail_window_is_complete(tmp_path: Path):
    """``end_turn`` stranded past the 4 KB tail window must still read COMPLETE.

    Regression for the "pinned at WORKING / never PENDING_USER" bug: the turn
    genuinely ended (``stop_reason=end_turn``) and Claude appended trailing
    ``last-prompt`` / ``system`` / envelope markers, but a large preceding
    ``tool_use`` line pushed the ``end_turn`` entry just past the 4 KB
    (``_TAIL_BYTES``) tail read. The ``last-prompt`` branch then saw no completed
    assistant in-window and fell through to WORKING — leaving a finished, idle
    worker stuck on the animated "Waiting" pill (``ready_for_input=False``,
    never projected to PENDING_USER). The tail read must widen until the
    completing assistant turn is in-window.
    """
    f = tmp_path / "session.jsonl"
    # A large final assistant turn (a long summary message is routine), so the
    # ``end_turn`` line's START lands > 4096 bytes from EOF once the trailing
    # ack/envelope run is appended — exactly the on-disk shape that pinned a
    # finished worker at WORKING.
    big_blob = "x" * 6000
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {
            "role": "assistant", "stop_reason": "end_turn",
            "content": [{"type": "text", "text": big_blob}]}},
        {"type": "system", "subtype": "info"},
        {"type": "last-prompt"},
        {"type": "last-prompt"},
        # Trailing ignored session-envelope run, exactly as Claude Code writes it.
        {"type": "ai-title"},
        {"type": "mode"},
        {"type": "permission-mode"},
    ])
    os.utime(f, None)
    # Sanity: the end_turn really is stranded past the 4 KB tail window.
    raw = f.read_bytes()
    assert len(raw) - raw.rindex(b'"end_turn"') > 4096
    assert _tail_status(f) == WorkerStatus.COMPLETE


def test_tail_status_last_prompt_between_tool_calls_is_not_complete(tmp_path: Path):
    """``last-prompt`` idle marker during an inter-tool pause must NOT be COMPLETE.

    Regression: the worker finished a tool (tool_result landed, so nothing is
    pending) and is slowly planning its next call — its last assistant turn ended
    with ``stop_reason=tool_use``. Claude rides a ``last-prompt`` idle ack in
    during that pause. Before the fix this was read as COMPLETE, cutting
    ``stream_transcript`` off mid-turn so ``flow diagnose`` falsely reported the
    result "not recorded". Only a real ``end_turn`` is terminal → here it stays
    WORKING so the stream keeps reading.
    """
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {
            "role": "assistant", "stop_reason": "tool_use",
            "content": [{"type": "tool_use", "id": "tu1", "name": "Bash", "input": {}}],
        }},
        {"type": "user", "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "tu1", "content": "ok"}],
        }},
        {"type": "last-prompt"},
    ])
    os.utime(f, None)
    assert _tail_status(f) == WorkerStatus.WORKING


def test_tail_status_waiting(tmp_path: Path):
    """Active file + last entry is a fresh user message (<90s) → WORKING."""
    f = tmp_path / "session.jsonl"
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    _write_jsonl(f, [
        {"type": "user", "timestamp": now_iso, "message": {"role": "user"}},
    ])
    os.utime(f, None)
    assert _tail_status(f) == WorkerStatus.WORKING


def test_tail_status_api_error(tmp_path: Path):
    """Active file + system subtype=api_error → API_ERROR."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "system", "subtype": "api_error", "message": "529 overloaded"},
    ])
    os.utime(f, None)
    assert _tail_status(f) == WorkerStatus.API_ERROR


def test_tail_status_inactive_stale_file(tmp_path: Path):
    """Stale file (mtime >5 min ago) with no terminal signal → INACTIVE."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": None, "content": []}},
    ])
    old = time.time() - 600
    os.utime(f, (old, old))
    assert _tail_status(f) == WorkerStatus.INACTIVE


def test_tail_status_unknown_fallback(tmp_path: Path):
    """Active file with unrecognised entry type → UNKNOWN (not hidden as RUNNING)."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "future-type-that-does-not-exist", "message": "?"},
    ])
    os.utime(f, None)
    assert _tail_status(f) == WorkerStatus.UNKNOWN


# ── ignored session-envelope types (regression: the UNKNOWN-flicker bug) ──────
#
# Claude Code writes content-free envelope lines (ai-title / agent-name / mode /
# bridge-session / permission-mode …) as a session prologue/epilogue. Before the
# fix, ``_IGNORED_TYPES`` skipped only ``permission-mode`` + ``file-history-snapshot``,
# so a real ``end_turn`` (COMPLETE) or ``tool_use`` (TOOL_CALL) followed by an
# envelope block was masked as UNKNOWN — yanking a still-active agent off the
# footer "active agents" chip and back on, i.e. the flicker.


def test_ignored_types_match_meta_types():
    """``_IGNORED_TYPES`` must equal the transcript parser's ``_META_TYPES`` minus
    ``last-prompt`` (which ``_tail_status`` classifies explicitly). This contract
    is the anti-drift guard: when Claude's format adds a new envelope type, the
    parser's set and this one must move together or this test fails."""
    from flow_sdk.transcript_analyzer.parsers.claude import _META_TYPES

    assert _IGNORED_TYPES == (_META_TYPES - {"last-prompt"})


# Envelope epilogues that previously masked the real signal as UNKNOWN. Each is
# a real assistant stop_reason followed by the content-free envelope block Claude
# Code appends — the worker is still in the stop_reason's state, not UNKNOWN.
@pytest.mark.parametrize("stop_reason,expected,envelope", [
    ("end_turn", WorkerStatus.COMPLETE, [
        {"type": "ai-title", "aiTitle": "some title"},
        {"type": "agent-name", "name": "some-agent"},
        {"type": "mode", "mode": "default"},
        {"type": "bridge-session", "sessionId": "abc"},
        {"type": "permission-mode", "permissionMode": "bypassPermissions"},
    ]),
    ("tool_use", WorkerStatus.TOOL_CALL, [
        {"type": "bridge-session", "sessionId": "abc"},
        {"type": "agent-name", "name": "some-agent"},
    ]),
])
def test_tail_status_signal_survives_envelope_epilogue(tmp_path, stop_reason, expected, envelope):
    """A real stop_reason followed by an envelope block keeps its status (the
    'agent flickers off the active-agents chip' scenario), not UNKNOWN."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": stop_reason, "content": []}},
        *envelope,
    ])
    os.utime(f, None)
    assert _tail_status(f) == expected


def test_tail_status_expands_past_envelope_run_beyond_4kb(tmp_path: Path):
    """A trailing envelope run larger than the initial 4 KB window must not bury
    the real terminal signal — the expanding tail read recovers COMPLETE."""
    f = tmp_path / "session.jsonl"
    pad = "x" * 400  # ~430 bytes/line → well over 4 KB across the envelope run
    entries = [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "end_turn", "content": []}},
    ]
    entries += [{"type": "bridge-session", "sessionId": "abc", "pad": pad} for _ in range(40)]
    _write_jsonl(f, entries)
    # Sanity: the envelope run genuinely exceeds the first read window.
    assert f.stat().st_size > _TAIL_BYTES
    os.utime(f, None)
    assert _tail_status(f) == WorkerStatus.COMPLETE


# ── is_ready_for_input truth table ───────────────────────────────────────────
#
# Contract (realigned): is_ready_for_input(p) ⇔ wire_status(p) == READY ⇔ the
# process is stored-RUNNING AND ¬busy. busy ⇔ prompt-lock held ∨ _turn_in_flight
# ∨ worker ∈ {initializing, working, thinking, tool_call, tool_running}.
# Everything else while RUNNING (idle/complete/interrupted/pending_user AND the
# fail-open error states error/api_error/api_timeout/inactive/unknown/None) is
# READY — the user can just re-prompt.


class _FakeProcess:
    """Minimal stand-in for AgenticProcess in the predicate truth-table."""

    _counter = 0

    def __init__(self, status: ProcessStatus, worker: WorkerStatus | None = None, session_id: str | None = None, turn_in_flight: bool = False):
        # Unique id so ``is_turn_busy`` → ``_prompt_lock_locked`` reads a fresh
        # (unlocked) per-process lock and never a lock a prior case left held.
        _FakeProcess._counter += 1
        self.id = f"fake-proc-{_FakeProcess._counter}"
        self.status = status.value
        self._worker = worker
        self.session_id = session_id
        self._turn_in_flight = turn_in_flight

    def fetch_worker_status(self) -> WorkerStatus | None:
        return self._worker


@pytest.mark.parametrize(
    "process_status,worker_status,expected",
    [
        # Ready states when RUNNING and no turn in flight
        (ProcessStatus.RUNNING, WorkerStatus.IDLE, True),
        (ProcessStatus.RUNNING, WorkerStatus.COMPLETE, True),
        (ProcessStatus.RUNNING, WorkerStatus.INTERRUPTED, True),
        # PENDING_USER (worker asked a question) — the user CAN respond → ready.
        (ProcessStatus.RUNNING, WorkerStatus.PENDING_USER, True),
        # Fail-open error/stale states — re-promptable, so ready (the exact error
        # still shows via the raw worker_status label / the ExecutionMode chip).
        (ProcessStatus.RUNNING, WorkerStatus.API_ERROR, True),
        (ProcessStatus.RUNNING, WorkerStatus.API_TIMEOUT, True),
        (ProcessStatus.RUNNING, WorkerStatus.ERROR, True),
        (ProcessStatus.RUNNING, WorkerStatus.INACTIVE, True),
        (ProcessStatus.RUNNING, WorkerStatus.UNKNOWN, True),
        # Busy — a turn is genuinely in flight (worker mid-turn).
        (ProcessStatus.RUNNING, WorkerStatus.THINKING, False),
        (ProcessStatus.RUNNING, WorkerStatus.WORKING, False),
        (ProcessStatus.RUNNING, WorkerStatus.TOOL_CALL, False),
        (ProcessStatus.RUNNING, WorkerStatus.TOOL_RUNNING, False),
        (ProcessStatus.RUNNING, WorkerStatus.INITIALIZING, False),
        # Any non-RUNNING lifecycle → never ready
        (ProcessStatus.NEW, WorkerStatus.IDLE, False),
        (ProcessStatus.STARTING, WorkerStatus.IDLE, False),
        (ProcessStatus.STOPPING, WorkerStatus.COMPLETE, False),
        (ProcessStatus.STOPPED, WorkerStatus.COMPLETE, False),
        (ProcessStatus.FAILED, WorkerStatus.ERROR, False),
    ],
)
def test_is_ready_for_input_truth_table(process_status, worker_status, expected):
    proc = _FakeProcess(process_status, worker_status)
    assert is_ready_for_input(proc, worker_status) is expected


@pytest.mark.parametrize(
    "process_status,worker_status,expected_wire",
    [
        (ProcessStatus.RUNNING, WorkerStatus.IDLE, "ready"),
        (ProcessStatus.RUNNING, WorkerStatus.PENDING_USER, "ready"),
        (ProcessStatus.RUNNING, WorkerStatus.API_ERROR, "ready"),
        (ProcessStatus.RUNNING, WorkerStatus.THINKING, "busy"),
        (ProcessStatus.RUNNING, WorkerStatus.INITIALIZING, "busy"),
        # Non-running stored values pass through unchanged (never ready/busy).
        (ProcessStatus.STARTING, WorkerStatus.INITIALIZING, "starting"),
        (ProcessStatus.STOPPED, WorkerStatus.COMPLETE, "stopped"),
        (ProcessStatus.FAILED, WorkerStatus.ERROR, "failed"),
    ],
)
def test_wire_status_projection(process_status, worker_status, expected_wire):
    """``wire_status`` projects stored ``running`` → ready/busy and passes every
    other stored value through unchanged. It is the ONLY place stored ``running``
    becomes ready/busy — and it never emits the literal ``running``."""
    from flow_sdk.builtin.agentic_process.status_predicates import wire_status

    proc = _FakeProcess(process_status, worker_status)
    assert wire_status(proc, worker_status) == expected_wire
    assert wire_status(proc, worker_status) != "running"


def test_is_turn_busy_signal_priority():
    """``is_turn_busy`` ORs three signals: prompt lock, ``_turn_in_flight``, and a
    mid-turn worker status. Any one → busy. This is the SAME predicate the
    switch-mode 409 and the wire ``busy`` status derive from."""
    from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy

    # (1) No lock, no turn, a ready worker → NOT busy (the held-lock case is
    #     covered separately in the async test below, which needs a running loop).
    p_ready = _FakeProcess(ProcessStatus.RUNNING, WorkerStatus.COMPLETE)
    assert is_turn_busy(p_ready, WorkerStatus.COMPLETE) is False

    # (2) _turn_in_flight → busy regardless of worker status.
    p_turn = _FakeProcess(ProcessStatus.RUNNING, WorkerStatus.COMPLETE, turn_in_flight=True)
    assert is_turn_busy(p_turn, WorkerStatus.COMPLETE) is True

    # (3) A mid-turn worker status → busy with no lock / no turn flag.
    p_worker = _FakeProcess(ProcessStatus.RUNNING, WorkerStatus.THINKING)
    assert is_turn_busy(p_worker, WorkerStatus.THINKING) is True

    # api_error is re-promptable → NOT busy (maps to a ready process status).
    p_api = _FakeProcess(ProcessStatus.RUNNING, WorkerStatus.API_ERROR)
    assert is_turn_busy(p_api, WorkerStatus.API_ERROR) is False


@pytest.mark.asyncio
async def test_is_turn_busy_held_prompt_lock():
    """A held prompt lock makes the turn busy even when the worker status looks
    ready — the switch-mode 409's authoritative in-flight signal for a
    native-xterm turn (which holds no _turn_in_flight flag)."""
    from flow_sdk.builtin.agentic_process import agentic_process as ap_mod
    from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy

    proc = _FakeProcess(ProcessStatus.RUNNING, WorkerStatus.COMPLETE)
    async with ap_mod._PROMPT_LOCKS[proc.id]:
        assert is_turn_busy(proc, WorkerStatus.COMPLETE) is True
    # Released → back to ready.
    assert is_turn_busy(proc, WorkerStatus.COMPLETE) is False


def test_is_ready_for_input_none_worker_turn_in_flight(tmp_path):
    """No transcript yet AND a turn is genuinely in flight → worker is busy.
    (Readiness gates on ``_turn_in_flight``, not ``session_id`` presence — the
    driver mints a session_id eagerly, so it can't mean "busy".)"""
    proc = _FakeProcess(ProcessStatus.RUNNING, None, session_id="sess-123", turn_in_flight=True)
    assert is_ready_for_input(proc) is False


def test_is_ready_for_input_none_worker_no_turn_is_ready():
    """No transcript yet AND no turn in flight → spawned-and-idle, ready for the
    first prompt — even with a session_id already assigned. Regression: this used
    to read busy forever, pinning new sessions on the 'Initializing' spinner."""
    assert is_ready_for_input(_FakeProcess(ProcessStatus.RUNNING, None, session_id="sess-123")) is True
    assert is_ready_for_input(_FakeProcess(ProcessStatus.RUNNING, None, session_id=None)) is True


# ── WorkerMode derivation ────────────────────────────────────────────────────


def test_worker_mode_enum_values():
    """Wire values are stable and exactly two."""
    assert WorkerMode.INTERACTIVE.value == "interactive"
    assert WorkerMode.CLI.value == "cli"
    assert {m.value for m in WorkerMode} == {"interactive", "cli"}


class _ModeProc:
    def __init__(self, pty_mode: bool):
        self.pty_mode = pty_mode


@pytest.mark.parametrize(
    "pty_mode,expected",
    [
        (True, WorkerMode.INTERACTIVE),
        (False, WorkerMode.CLI),
    ],
)
def test_get_worker_mode_derivation(pty_mode, expected):
    """WorkerMode keys on the transport ``pty_mode`` — a hidden live PTY
    (pty_mode=True) is INTERACTIVE regardless of tab visibility."""
    assert get_worker_mode(_ModeProc(pty_mode)) is expected


# ── Field-removal regression guards ──────────────────────────────────────────


def test_is_active_field_removed():
    """``is_active`` must not exist on the AgenticProcess pydantic model."""
    assert "is_active" not in AgenticProcess.model_fields


def test_waiting_for_prompt_field_removed():
    """``waiting_for_prompt`` must not exist on the AgenticProcess pydantic model."""
    assert "waiting_for_prompt" not in AgenticProcess.model_fields


def test_waiting_for_prompt_property_removed():
    """``waiting_for_prompt`` must no longer exist as a Python property either."""
    assert not hasattr(AgenticProcess, "waiting_for_prompt")


# ── Lifecycle transitions via public surface ─────────────────────────────────


def test_process_default_status_is_new():
    proc = AgenticProcess()
    assert proc.status == ProcessStatus.NEW.value


def test_process_can_transition_to_running():
    """Writing ``ProcessStatus.RUNNING.value`` is the canonical "worker alive" mark."""
    proc = AgenticProcess()
    proc.status = ProcessStatus.RUNNING.value
    assert proc.status == "running"


def test_process_failed_terminal_state():
    proc = AgenticProcess()
    proc.status = ProcessStatus.FAILED.value
    assert proc.is_idle  # FAILED is one of the idle-lifecycle states


# ── Serializer injection branch (worker_status / ready_for_input) ─────────────
#
# ``worker_status`` and ``ready_for_input`` are NOT stored — they are projected
# onto the wire payload each serialize by ``api_json_serializer`` (the live
# ``model_dump`` path). The projection is: ``worker_status`` = the computed
# WorkerStatus (or ``"idle"`` when the transcript hasn't been discovered), and
# ``ready_for_input`` = ``is_ready_for_input(self, computed)``. These tests pin
# that branch directly, driven only by a monkeypatched ``fetch_worker_status``
# (no server, no transcript) so the projection is asserted independently.


@pytest.mark.parametrize(
    "computed,exp_worker_status,exp_status,exp_ready",
    [
        # Ready worker states → raw worker_status verbatim, wire status ready.
        (WorkerStatus.COMPLETE, "complete", "ready", True),
        (WorkerStatus.IDLE, "idle", "ready", True),
        (WorkerStatus.INTERRUPTED, "interrupted", "ready", True),
        # Fail-open: error/stale worker states are re-promptable → wire ready,
        # but the raw worker_status is surfaced verbatim ("what we found").
        (WorkerStatus.ERROR, "error", "ready", True),
        # Busy worker states → wire status busy, not ready.
        (WorkerStatus.THINKING, "thinking", "busy", False),
        (WorkerStatus.TOOL_RUNNING, "tool_running", "busy", False),
        (WorkerStatus.INITIALIZING, "initializing", "busy", False),
        # Undiscovered transcript → worker_status is NULL (never coerced to a
        # placeholder); wire status ready (spawned-and-idle, no turn in flight).
        (None, None, "ready", True),
    ],
)
def test_api_json_serializer_projects_status_axes(
    monkeypatch, computed, exp_worker_status, exp_status, exp_ready
):
    """The live serializer projects the wire ``status`` (ready/busy), surfaces the
    raw nullable ``worker_status``, and derives ``ready_for_input`` — all on the
    RUNNING process payload. The stored FSM value ``running`` is never emitted."""
    proc = AgenticProcess()
    proc.status = ProcessStatus.RUNNING.value
    monkeypatch.setattr(AgenticProcess, "fetch_worker_status", lambda self: computed)

    payload = proc.model_dump(mode="json")
    assert payload["worker_status"] == exp_worker_status
    assert payload["status"] == exp_status
    assert payload["status"] != "running"
    assert payload["ready_for_input"] is exp_ready


def test_api_json_serializer_ready_false_when_not_running(monkeypatch):
    """A COMPLETE worker on a non-RUNNING container is never ready, and its wire
    status passes through as the stored lifecycle value (not projected)."""
    proc = AgenticProcess()
    proc.status = ProcessStatus.STOPPED.value
    monkeypatch.setattr(AgenticProcess, "fetch_worker_status", lambda self: WorkerStatus.COMPLETE)

    payload = proc.model_dump(mode="json")
    assert payload["worker_status"] == "complete"
    assert payload["status"] == "stopped"
    assert payload["ready_for_input"] is False


def test_api_json_serializer_never_emits_stored_running(monkeypatch):
    """Regression: the wire ``status`` must never be the stored ``running`` — a
    RUNNING process always projects to ready or busy."""
    for computed in (WorkerStatus.IDLE, WorkerStatus.THINKING, None):
        proc = AgenticProcess()
        proc.status = ProcessStatus.RUNNING.value
        monkeypatch.setattr(AgenticProcess, "fetch_worker_status", lambda self, c=computed: c)
        payload = proc.model_dump(mode="json")
        assert payload["status"] in ("ready", "busy")


def test_api_json_serializer_skip_context_suppresses_injection(monkeypatch):
    """The ``skip_api_serializer`` context short-circuits the projection — the
    computed fields are NOT injected (used by the internal persistence dump that
    must not pay the tail-read cost)."""
    proc = AgenticProcess()
    proc.status = ProcessStatus.RUNNING.value
    monkeypatch.setattr(AgenticProcess, "fetch_worker_status", lambda self: WorkerStatus.COMPLETE)

    payload = proc.model_dump(mode="json", context={"skip_api_serializer": True})
    assert "worker_status" not in payload
    assert "ready_for_input" not in payload
