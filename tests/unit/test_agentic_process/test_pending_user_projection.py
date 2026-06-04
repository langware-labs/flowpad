"""H4: WorkerStatus.PENDING_USER projection + terminal_at lifecycle.

Covers the serializer-layer projection that turns underlying terminal
statuses into PENDING_USER (age < 5min) or INACTIVE (age >= 5min), and the
flush-side lifecycle that maintains ``terminal_at`` itself.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
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


def test_projection_recent_terminal_becomes_pending_user(monkeypatch) -> None:
    ap = _make_ap()
    ap.terminal_at = datetime.now(timezone.utc) - timedelta(seconds=60)  # 1 min ago
    monkeypatch.setattr(
        type(ap), "driver",
        property(lambda self: _StubDriver(WorkerStatus.COMPLETE)),
        raising=False,
    )
    assert ap._discover_status_from_transcript() == WorkerStatus.PENDING_USER


def test_projection_aged_terminal_becomes_inactive(monkeypatch) -> None:
    ap = _make_ap()
    ap.terminal_at = datetime.now(timezone.utc) - timedelta(seconds=400)  # > 5 min
    monkeypatch.setattr(
        type(ap), "driver",
        property(lambda self: _StubDriver(WorkerStatus.COMPLETE)),
        raising=False,
    )
    assert ap._discover_status_from_transcript() == WorkerStatus.INACTIVE


def test_projection_skipped_when_terminal_at_unset(monkeypatch) -> None:
    """If terminal_at is None we keep the raw underlying status — the
    projection layer is opt-in via the field being set."""
    ap = _make_ap()
    assert ap.terminal_at is None
    monkeypatch.setattr(
        type(ap), "driver",
        property(lambda self: _StubDriver(WorkerStatus.COMPLETE)),
        raising=False,
    )
    assert ap._discover_status_from_transcript() == WorkerStatus.COMPLETE


def test_projection_only_applies_to_clean_terminals(monkeypatch) -> None:
    """API_TIMEOUT and INACTIVE aren't projected — they're terminal-with-cause
    and shouldn't pass through the PendingUser grace window."""
    ap = _make_ap()
    ap.terminal_at = datetime.now(timezone.utc) - timedelta(seconds=60)
    for raw in (WorkerStatus.API_TIMEOUT, WorkerStatus.INACTIVE):
        monkeypatch.setattr(
            type(ap), "driver",
            property(lambda self, r=raw: _StubDriver(r)),
            raising=False,
        )
        assert ap._discover_status_from_transcript() == raw


class _StubDriver:
    """Minimal driver shim — owns the tail_status return value + a fixed
    transcript_path so the AP's _discover_status_from_transcript reaches
    the projection branch."""

    def __init__(self, status: WorkerStatus) -> None:
        self.next_status = status

    def tail_status(self, _path: Path) -> WorkerStatus:
        return self.next_status

    def transcript_path(self, _ap: AgenticProcess) -> Path:
        # Any path the AP's stat() will see — projection ignores the value
        # because we override tail_status.
        return Path("/tmp/_pending_user_projection_test.jsonl")
