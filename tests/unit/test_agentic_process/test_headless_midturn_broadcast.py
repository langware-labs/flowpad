"""Realignment: a HEADLESS (pty_mode=False) turn broadcasts its worker-status
transitions mid-turn.

Root cause of the old "headless never updates mid-turn" bug: the transcript
streamer DID watch headless JSONLs and ``_flush_transcript_change`` DID run, but
``_discover_status_from_transcript`` short-circuited to INITIALIZING for the whole
turn whenever ``_turn_in_flight`` was set — so every flush computed the same
status and the transition-gated ``notify_updated`` never fired.

Removing that pin makes the raw tail flow through, so mid-turn transitions
(thinking → tool_call → complete) broadcast for headless exactly as for PTY. The
broadcast key is the TRIPLE (status, busy, worker_status), so both the busy→ready
wire flip and the raw worker moves within a busy turn broadcast.

Drives the REAL flush path (real ``_tail_status`` over real JSONL file writes) —
only ``driver`` + ``notify_updated`` are shimmed, never the status logic.
"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.worker_status import WorkerStatus, _tail_status
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


class _RealTailDriver:
    """Driver shim that reads a REAL JSONL file via the canonical ``_tail_status``
    — no status mocking, just a fixed transcript path."""

    def __init__(self, path: Path) -> None:
        self._path = path

    def transcript_path(self, _ap: AgenticProcess) -> Path:
        return self._path

    def tail_status(self, path: Path) -> WorkerStatus:
        return _tail_status(path)


def _write(path: Path, entries: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(e) for e in entries))
    os.utime(path, None)  # fresh mtime → file is "active"


async def _make_headless_ap(monkeypatch, path: Path) -> AgenticProcess:
    ap = AgenticProcess(
        id=str(uuid.uuid4()),
        session_id="00000000-0000-0000-0000-000000000042",
        worker_type=WorkerType.CLAUDE_CODE,
    )
    ap.status = ProcessStatus.RUNNING.value
    ap.pty_mode = False  # HEADLESS transport
    # A headless turn is in flight for its whole duration. Under the OLD code this
    # pinned worker_status to INITIALIZING and suppressed every broadcast.
    object.__setattr__(ap, "_turn_in_flight", True)
    monkeypatch.setattr(
        type(ap), "driver", property(lambda self: _RealTailDriver(path)), raising=False,
    )
    return ap


@pytest.mark.asyncio
async def test_headless_turn_in_flight_reads_raw_tail_not_initializing(
    initialize_test_db, monkeypatch, tmp_path
) -> None:
    """With a headless turn in flight, the worker status is the RAW tail
    (thinking), NOT a pinned INITIALIZING — this is what unblocks mid-turn
    broadcasts."""
    path = tmp_path / "session.jsonl"
    _write(path, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": None, "content": []}},
    ])
    ap = await _make_headless_ap(monkeypatch, path)
    assert ap.fetch_worker_status() == WorkerStatus.THINKING


@pytest.mark.asyncio
async def test_headless_midturn_transition_broadcasts(
    initialize_test_db, monkeypatch, tmp_path
) -> None:
    """A headless mid-turn move (thinking → tool_call) broadcasts, even though the
    wire status stays ``busy`` across both — the pair key catches the raw move."""
    path = tmp_path / "session.jsonl"
    _write(path, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": None, "content": []}},
    ])
    ap = await _make_headless_ap(monkeypatch, path)

    notify_calls: list[None] = []

    async def _fake_notify():
        notify_calls.append(None)

    monkeypatch.setattr(type(ap), "notify_updated", lambda self: _fake_notify(), raising=False)

    # First flush: thinking → wire busy. Broadcasts (fresh key).
    await ap.on_transcript_change(path, [])
    await ap._debounce_task
    assert notify_calls == [None]
    assert ap._last_broadcast_key == ("running", True, "thinking")

    # Worker advances to a tool call — same busy, different worker.
    _write(path, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "tool_use", "content": []}},
    ])
    await ap.on_transcript_change(path, [])
    await ap._debounce_task
    # The triple key changed (…,thinking) → (…,tool_call), so it re-broadcasts.
    assert notify_calls == [None, None]
    assert ap._last_broadcast_key == ("running", True, "tool_call")


@pytest.mark.asyncio
async def test_headless_turn_end_flips_wire_to_ready(
    initialize_test_db, monkeypatch, tmp_path
) -> None:
    """At turn end the worker writes end_turn (COMPLETE); the turn is no longer in
    flight so ``busy`` flips true → false and broadcasts."""
    path = tmp_path / "session.jsonl"
    _write(path, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": None, "content": []}},
    ])
    ap = await _make_headless_ap(monkeypatch, path)

    notify_calls: list[None] = []

    async def _fake_notify():
        notify_calls.append(None)

    monkeypatch.setattr(type(ap), "notify_updated", lambda self: _fake_notify(), raising=False)

    await ap.on_transcript_change(path, [])
    await ap._debounce_task
    assert ap._last_broadcast_key == ("running", True, "thinking")

    # Turn ends: end_turn on disk AND the driver clears _turn_in_flight.
    _write(path, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "end_turn", "content": []}},
    ])
    object.__setattr__(ap, "_turn_in_flight", False)
    await ap.on_transcript_change(path, [])
    await ap._debounce_task
    assert ap._last_broadcast_key == ("running", False, "complete")
    assert notify_calls == [None, None]
