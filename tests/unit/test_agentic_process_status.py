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


# ── classify_execution_mode truth table ──────────────────────────────────────


def test_classify_execution_mode_truth_table():
    from flow_sdk.builtin.worker_status import ExecutionMode, classify_execution_mode

    # Not live → None.
    for s in ("new", "stopping", "stopped", "failed"):
        assert classify_execution_mode(status=s, worker_status=None, visible=True) is None

    # Live PTY / CLI split.
    for s in ("running", "starting"):
        assert (
            classify_execution_mode(status=s, worker_status=None, visible=True)
            == ExecutionMode.INTERACTIVE
        )
        assert (
            classify_execution_mode(status=s, worker_status=None, visible=False)
            == ExecutionMode.BACKGROUND
        )

    # Error worker_status wins over visible, for both PTY and CLI.
    for w in ("error", "api_timeout", "inactive"):
        assert (
            classify_execution_mode(status="running", worker_status=w, visible=True)
            == ExecutionMode.ERROR
        )
        assert (
            classify_execution_mode(status="running", worker_status=w, visible=False)
            == ExecutionMode.ERROR
        )

    # Dead PTY pid → Error; CLI without pid liveness stays Background.
    assert (
        classify_execution_mode(status="running", worker_status=None, visible=True, pid_alive=False)
        == ExecutionMode.ERROR
    )
    assert (
        classify_execution_mode(status="running", worker_status=None, visible=False)
        == ExecutionMode.BACKGROUND
    )


# ── ProcessStatus enum shape ─────────────────────────────────────────────────


def test_process_status_values():
    assert ProcessStatus.NEW.value == "new"
    assert ProcessStatus.STARTING.value == "starting"
    assert ProcessStatus.RUNNING.value == "running"
    assert ProcessStatus.STOPPING.value == "stopping"
    assert ProcessStatus.STOPPED.value == "stopped"
    assert ProcessStatus.FAILED.value == "failed"


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
    "waiting",
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
    is PENDING_USER ("Waiting for you"), NOT TOOL_CALL — Claude has yielded to
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

    Regression for the "pinned at WAITING / never PENDING_USER" bug: the turn
    genuinely ended (``stop_reason=end_turn``) and Claude appended trailing
    ``last-prompt`` / ``system`` / envelope markers, but a large preceding
    ``tool_use`` line pushed the ``end_turn`` entry just past the 4 KB
    (``_TAIL_BYTES``) tail read. The ``last-prompt`` branch then saw no completed
    assistant in-window and fell through to WAITING — leaving a finished, idle
    worker stuck on the animated "Waiting" pill (``ready_for_input=False``,
    never projected to PENDING_USER). The tail read must widen until the
    completing assistant turn is in-window.
    """
    f = tmp_path / "session.jsonl"
    # A large final assistant turn (a long summary message is routine), so the
    # ``end_turn`` line's START lands > 4096 bytes from EOF once the trailing
    # ack/envelope run is appended — exactly the on-disk shape that pinned a
    # finished worker at WAITING.
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
    WAITING so the stream keeps reading.
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
    assert _tail_status(f) == WorkerStatus.WAITING


def test_tail_status_waiting(tmp_path: Path):
    """Active file + last entry is a fresh user message (<90s) → WAITING."""
    f = tmp_path / "session.jsonl"
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    _write_jsonl(f, [
        {"type": "user", "timestamp": now_iso, "message": {"role": "user"}},
    ])
    os.utime(f, None)
    assert _tail_status(f) == WorkerStatus.WAITING


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
# Contract: status == RUNNING AND worker_status ∈ {IDLE, COMPLETE, INTERRUPTED}.


class _FakeProcess:
    """Minimal stand-in for AgenticProcess in the predicate truth-table."""

    def __init__(self, status: ProcessStatus, worker: WorkerStatus | None = None, session_id: str | None = None, turn_in_flight: bool = False):
        self.status = status.value
        self._worker = worker
        self.session_id = session_id
        self._turn_in_flight = turn_in_flight

    def fetch_worker_status(self) -> WorkerStatus | None:
        return self._worker


@pytest.mark.parametrize(
    "process_status,worker_status,expected",
    [
        # Ready states when LIVE=RUNNING
        (ProcessStatus.RUNNING, WorkerStatus.IDLE, True),
        (ProcessStatus.RUNNING, WorkerStatus.COMPLETE, True),
        (ProcessStatus.RUNNING, WorkerStatus.INTERRUPTED, True),
        # Not ready while worker is mid-turn
        (ProcessStatus.RUNNING, WorkerStatus.THINKING, False),
        (ProcessStatus.RUNNING, WorkerStatus.WAITING, False),
        (ProcessStatus.RUNNING, WorkerStatus.TOOL_CALL, False),
        (ProcessStatus.RUNNING, WorkerStatus.TOOL_RUNNING, False),
        (ProcessStatus.RUNNING, WorkerStatus.API_ERROR, False),
        (ProcessStatus.RUNNING, WorkerStatus.API_TIMEOUT, False),
        (ProcessStatus.RUNNING, WorkerStatus.ERROR, False),
        (ProcessStatus.RUNNING, WorkerStatus.INACTIVE, False),
        (ProcessStatus.RUNNING, WorkerStatus.INITIALIZING, False),
        (ProcessStatus.RUNNING, WorkerStatus.UNKNOWN, False),
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
    def __init__(self, visible: bool):
        self.visible = visible


@pytest.mark.parametrize(
    "visible,expected",
    [
        (True, WorkerMode.INTERACTIVE),
        (False, WorkerMode.CLI),
    ],
)
def test_get_worker_mode_derivation(visible, expected):
    assert get_worker_mode(_ModeProc(visible)) is expected


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
