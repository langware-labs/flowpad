"""Regression: a spawned-but-never-prompted worker must read IDLE/ready, not
pin "Initializing" forever.

Opening a fresh agentic_process dock starts the worker (``status → RUNNING``)
before any prompt is sent, so no transcript JSONL exists yet. The projection
used to label that state ``INITIALIZING`` whenever a ``session_id``/``shell_id``
was present — and since a never-prompted session never writes a transcript, the
status pill stayed on the spinner forever. The correct reading is:

  * a turn genuinely spinning up (``_turn_in_flight``)            → INITIALIZING
  * the process lifecycle still coming up (``STARTING``)          → INITIALIZING
  * RUNNING with no in-flight turn and no transcript yet          → IDLE (ready)

This file locks all three branches plus the two supporting predicates
(``_tail_status`` honouring Claude's ``system:init`` line, and
``is_ready_for_input`` gating on ``_turn_in_flight`` rather than ``session_id``).
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.status_predicates import is_ready_for_input
from flow_sdk.builtin.worker_status import WorkerStatus, _tail_status
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType


pytestmark = pytest.mark.timeout(30)


class _NoTranscriptDriver:
    """Driver shim for the pre-prompt state: the worker is spawned but hasn't
    written a transcript yet, so ``transcript_path`` resolves to None."""

    def transcript_path(self, _ap: AgenticProcess) -> None:
        return None

    def tail_status(self, _path: Path) -> WorkerStatus:  # pragma: no cover
        raise AssertionError("tail_status must not be called when path is None")


def _make_ap(
    monkeypatch,
    *,
    status: ProcessStatus = ProcessStatus.RUNNING,
    turn_in_flight: bool = False,
    session_id: str | None = "00000000-0000-0000-0000-000000000001",
) -> AgenticProcess:
    ap = AgenticProcess(
        id=str(uuid.uuid4()),
        session_id=session_id,
        worker_type=WorkerType.CLAUDE_CODE,
        status=status.value,
    )
    object.__setattr__(ap, "_turn_in_flight", turn_in_flight)
    monkeypatch.setattr(
        type(ap), "driver",
        property(lambda self: _NoTranscriptDriver()),
        raising=False,
    )
    return ap


# ── projection (_discover_status_from_transcript) ────────────────────────────

def test_running_no_transcript_no_turn_is_idle(monkeypatch) -> None:
    """THE REGRESSION: a never-prompted RUNNING worker is idle/ready, not
    initialising."""
    ap = _make_ap(monkeypatch, status=ProcessStatus.RUNNING, turn_in_flight=False)
    assert ap._discover_status_from_transcript() == WorkerStatus.IDLE


def test_running_no_transcript_turn_in_flight_is_initializing(monkeypatch) -> None:
    """A genuine turn spinning up still reads INITIALIZING — no flicker on a
    real prompt (this is the behaviour the old eager-session_id hack protected)."""
    ap = _make_ap(monkeypatch, status=ProcessStatus.RUNNING, turn_in_flight=True)
    assert ap._discover_status_from_transcript() == WorkerStatus.INITIALIZING


def test_starting_no_transcript_is_initializing(monkeypatch) -> None:
    """The pre-RUNNING lifecycle boot is true initialisation."""
    ap = _make_ap(monkeypatch, status=ProcessStatus.STARTING, turn_in_flight=False)
    assert ap._discover_status_from_transcript() == WorkerStatus.INITIALIZING


def test_running_no_session_or_shell_is_none(monkeypatch) -> None:
    """No identity at all → no derivable status (serializer maps None → IDLE)."""
    ap = _make_ap(monkeypatch, status=ProcessStatus.RUNNING, session_id=None)
    object.__setattr__(ap, "shell_id", None)
    assert ap._discover_status_from_transcript() is None


# ── is_ready_for_input gates on _turn_in_flight, not session_id ──────────────

def test_ready_for_input_spawned_session_no_turn(monkeypatch) -> None:
    """A spawned session (session_id present) with no turn in flight is ready to
    accept its first prompt — the bug had it reading busy forever."""
    ap = _make_ap(monkeypatch, status=ProcessStatus.RUNNING, turn_in_flight=False)
    assert is_ready_for_input(ap) is True


def test_not_ready_for_input_while_turn_in_flight(monkeypatch) -> None:
    ap = _make_ap(monkeypatch, status=ProcessStatus.RUNNING, turn_in_flight=True)
    assert is_ready_for_input(ap) is False


# ── _tail_status honours Claude's system:init line ──────────────────────────

def test_tail_status_system_init_is_idle(tmp_path: Path) -> None:
    """``system:init`` is Claude's first JSONL line — booted and idle at the
    prompt, not 'still initialising' and not UNKNOWN."""
    p = tmp_path / "session.jsonl"
    p.write_text(json.dumps({"type": "system", "subtype": "init", "session_id": "x"}) + "\n")
    assert _tail_status(p) == WorkerStatus.IDLE


def test_tail_status_missing_file_still_initializing(tmp_path: Path) -> None:
    """Sanity: a genuinely-missing transcript still reads INITIALIZING."""
    assert _tail_status(tmp_path / "nope.jsonl") == WorkerStatus.INITIALIZING
