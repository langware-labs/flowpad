"""Realigned: ``_discover_status_from_transcript`` returns the RAW worker status
with NO projection.

The former PENDING_USER (recent) / INACTIVE (aged) projection over ``terminal_at``
was removed — worker status is now "what we found" (raw), and the ready/busy
meaning is derived separately by ``status_predicates``. These tests pin that the
raw ``tail_status`` value passes straight through regardless of ``terminal_at``
age, and that a raw ``pending_user`` / ``inactive`` (which ``_tail_status`` CAN
return directly) is not re-synthesized.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.worker_status import WorkerStatus
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType


pytestmark = pytest.mark.timeout(30)


def _make_ap(status: ProcessStatus = ProcessStatus.RUNNING) -> AgenticProcess:
    return AgenticProcess(
        id=str(uuid.uuid4()),
        session_id="00000000-0000-0000-0000-000000000001",
        worker_type=WorkerType.CLAUDE_CODE,
        status=status.value,
    )


@pytest.mark.parametrize(
    "raw",
    [
        WorkerStatus.COMPLETE,
        WorkerStatus.ERROR,
        WorkerStatus.INTERRUPTED,
        WorkerStatus.PENDING_USER,
        WorkerStatus.INACTIVE,
        WorkerStatus.API_TIMEOUT,
        WorkerStatus.THINKING,
        WorkerStatus.IDLE,
    ],
)
def test_raw_status_passes_through_unprojected(monkeypatch, raw) -> None:
    """Whatever ``tail_status`` returns is what ``_discover_status_from_transcript``
    returns — no projection layer rewrites it."""
    ap = _make_ap()
    monkeypatch.setattr(
        type(ap), "driver",
        property(lambda self, r=raw: _StubDriver(r)),
        raising=False,
    )
    assert ap._discover_status_from_transcript() == raw


def test_terminal_stays_raw_complete_regardless_of_age(monkeypatch) -> None:
    """A finished COMPLETE stays COMPLETE — the removed projection used to flip it
    to PENDING_USER (recent) / INACTIVE (aged >5min) against a stored terminal
    instant. There is no age to project against anymore (the `terminal_at` field
    and the projection are both gone), so the raw status is authoritative."""
    ap = _make_ap()
    monkeypatch.setattr(
        type(ap), "driver",
        property(lambda self: _StubDriver(WorkerStatus.COMPLETE)),
        raising=False,
    )
    assert ap._discover_status_from_transcript() == WorkerStatus.COMPLETE


class _StubDriver:
    """Minimal driver shim — owns the tail_status return value + a fixed
    transcript_path so the AP's _discover_status_from_transcript reaches the
    tail read."""

    def __init__(self, status: WorkerStatus, path: Path | None = None) -> None:
        self.next_status = status
        self._path = path if path is not None else Path("/tmp/_raw_status_test.jsonl")

    def tail_status(self, _path: Path) -> WorkerStatus:
        return self.next_status

    def transcript_path(self, _ap: AgenticProcess) -> Path:
        return self._path
