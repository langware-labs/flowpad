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
from flow_sdk.fs_records.agent_status import (
    _RUNNING_STATUSES,
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


def test_tail_status_tool_running(tmp_path: Path):
    """Active file + last entry type=progress → TOOL_RUNNING."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "progress", "message": {"phase": "tool"}},
    ])
    os.utime(f, None)
    assert _tail_status(f) == WorkerStatus.TOOL_RUNNING


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


# ── is_ready_for_input truth table ───────────────────────────────────────────
#
# Contract: status == RUNNING AND worker_status ∈ {IDLE, COMPLETE, INTERRUPTED}.


class _FakeProcess:
    """Minimal stand-in for AgenticProcess in the predicate truth-table."""

    def __init__(self, status: ProcessStatus, worker: WorkerStatus | None = None, session_id: str | None = None):
        self.status = status.value
        self._worker = worker
        self.session_id = session_id

    def _discover_status_from_transcript(self) -> WorkerStatus | None:
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


def test_is_ready_for_input_none_worker_with_session(tmp_path):
    """No transcript yet AND session_id set → worker was just launched → not ready."""
    proc = _FakeProcess(ProcessStatus.RUNNING, None, session_id="sess-123")
    assert is_ready_for_input(proc) is False


def test_is_ready_for_input_none_worker_without_session():
    """No transcript yet AND no session_id → never prompted → ready."""
    proc = _FakeProcess(ProcessStatus.RUNNING, None, session_id=None)
    assert is_ready_for_input(proc) is True


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
