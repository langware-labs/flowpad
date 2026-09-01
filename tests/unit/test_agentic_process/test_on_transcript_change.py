"""T10: AgenticProcess.on_transcript_change + _flush_transcript_change.

Covers the streamer-driven status update path that replaced _poll_for_completion:

  - on_transcript_change buffers entries and arms a 1-second debounce timer
  - Multiple rapid calls within the window coalesce into ONE flush
  - The flush is idempotent — running with no transitions does nothing visible
  - Status transitions trigger notify_updated; equal status does not
  - API_TIMEOUT invokes _on_timeout
  - Defensive: flush short-circuits when AP is no longer RUNNING
  - Buffer cap protects against pathological writers

Real AP entities (no AgentTranscriptFile/parser mocks); status is driven by
monkeypatching ``_discover_status_from_transcript`` — the same wrapper the
flush uses, so we exercise the live decision logic.
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.builtin.worker_status import WorkerStatus
from flow_sdk.flowpad_types.enums import WorkerType

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


async def _make_ap(status: WorkerStatus, monkeypatch) -> AgenticProcess:
    """Construct a minimal AP with RUNNING lifecycle. Status-derivation is
    monkeypatched on the class so the flush sees the requested value via
    ``_discover_status_from_transcript`` — the single source of truth used by
    the serializer / get_status / flush."""
    ap = AgenticProcess(
        id=str(uuid.uuid4()),
        session_id="00000000-0000-0000-0000-000000000001",
        worker_type=WorkerType.CLAUDE_CODE,
    )
    ap.status = ProcessStatus.RUNNING.value
    await ap.save(notify=False)
    monkeypatch.setattr(
        type(ap),
        "_discover_status_from_transcript",
        lambda self: status,
        raising=False,
    )
    return ap


@pytest.mark.asyncio
async def test_buffer_extends_and_arms_debounce(initialize_test_db, monkeypatch) -> None:
    """on_transcript_change extends the pending buffer and arms one task."""
    ap = await _make_ap(WorkerStatus.THINKING, monkeypatch)

    await ap.on_transcript_change(Path("/tmp/x.jsonl"), ["e1", "e2"])
    assert ap._pending_entries == ["e1", "e2"]
    assert ap._debounce_task is not None
    first_task = ap._debounce_task

    await ap.on_transcript_change(Path("/tmp/x.jsonl"), ["e3"])
    assert ap._pending_entries == ["e1", "e2", "e3"]
    assert ap._debounce_task is first_task

    first_task.cancel()
    try:
        await first_task
    except (asyncio.CancelledError, Exception):
        pass


@pytest.mark.long  # 1.02s
@pytest.mark.asyncio
async def test_flush_broadcasts_on_status_transition(initialize_test_db, monkeypatch) -> None:
    """A change from (running, busy, thinking) → (running, ¬busy, complete)
    triggers notify_updated once. The broadcast key is the TRIPLE (status, busy,
    worker_status)."""
    ap = await _make_ap(WorkerStatus.COMPLETE, monkeypatch)
    object.__setattr__(ap, "_last_broadcast_key", ("running", True, "thinking"))

    notify_calls: list[None] = []

    async def _fake_notify():
        notify_calls.append(None)

    monkeypatch.setattr(type(ap), "notify_updated", lambda self: _fake_notify(), raising=False)

    await ap.on_transcript_change(Path("/tmp/x.jsonl"), [])
    await ap._debounce_task

    assert notify_calls == [None]
    # COMPLETE is ¬busy while running.
    assert ap._last_broadcast_key == ("running", False, "complete")


@pytest.mark.long  # 1.03s
@pytest.mark.asyncio
async def test_flush_broadcasts_on_wire_flip_same_worker(initialize_test_db, monkeypatch) -> None:
    """A busy→¬busy flip with an UNCHANGED worker status still broadcasts — the
    triple key catches it (e.g. the prompt lock releases before the tail moves).
    Here the worker reads COMPLETE both before and after, but busy flips."""
    ap = await _make_ap(WorkerStatus.COMPLETE, monkeypatch)
    # Prior broadcast: same worker (complete) but busy was true (a turn had been
    # in flight). Now no turn in flight → busy false → must broadcast.
    object.__setattr__(ap, "_last_broadcast_key", ("running", True, "complete"))

    notify_calls: list[None] = []

    async def _fake_notify():
        notify_calls.append(None)

    monkeypatch.setattr(type(ap), "notify_updated", lambda self: _fake_notify(), raising=False)

    await ap.on_transcript_change(Path("/tmp/x.jsonl"), [])
    await ap._debounce_task

    assert notify_calls == [None]
    assert ap._last_broadcast_key == ("running", False, "complete")


@pytest.mark.long  # 1.02s
@pytest.mark.asyncio
async def test_flush_skips_broadcast_when_status_unchanged(initialize_test_db, monkeypatch) -> None:
    """No transition in the (status, busy, worker) triple → no notify_updated."""
    ap = await _make_ap(WorkerStatus.THINKING, monkeypatch)
    # THINKING is busy. Same triple already broadcast.
    object.__setattr__(ap, "_last_broadcast_key", ("running", True, "thinking"))

    notify_calls: list[None] = []

    async def _fake_notify():
        notify_calls.append(None)

    monkeypatch.setattr(type(ap), "notify_updated", lambda self: _fake_notify(), raising=False)

    await ap.on_transcript_change(Path("/tmp/x.jsonl"), [])
    await ap._debounce_task

    assert notify_calls == []


@pytest.mark.long  # 2.06s
@pytest.mark.asyncio
async def test_a_rehydrated_flush_dedups_against_the_previous_one(
    initialize_test_db, monkeypatch
) -> None:
    """The dedup gate across the REHYDRATION — the axis the seeded-key tests miss.

    The transcript watcher hydrates a FRESH AgenticProcess per streamer event, so
    the only way the gate can ever match is if the key outlives the instance that
    wrote it. Seeding ``_last_broadcast_key`` by hand on one object proves nothing
    about that: it passes with a plain instance attribute too. Here the second
    flush runs on an object loaded from the row — same process, different Python
    object, nothing seeded — and the key must still be there to dedup against.
    """
    first = await _make_ap(WorkerStatus.THINKING, monkeypatch)

    notify_calls: list[None] = []

    async def _fake_notify():
        notify_calls.append(None)

    monkeypatch.setattr(type(first), "notify_updated", lambda self: _fake_notify(), raising=False)

    await first.on_transcript_change(Path("/tmp/x.jsonl"), [])
    await first._debounce_task
    assert notify_calls == [None], "the first flush is a transition — it must broadcast"

    second = await AgenticProcess.get_by_id(str(first.id))
    assert second is not None and second is not first
    assert second._last_broadcast_key == ("running", True, "thinking"), (
        "the key must survive the per-event rehydration"
    )

    await second.on_transcript_change(Path("/tmp/x.jsonl"), [])
    await second._debounce_task

    assert notify_calls == [None], "nothing changed — the rehydrated flush must not re-broadcast"


@pytest.mark.long  # 4.23s
@pytest.mark.asyncio
async def test_on_timeout_fires_once_per_transition_not_once_per_flush(
    initialize_test_db, monkeypatch
) -> None:
    """The gate's second consumer: everything BELOW the early return.

    ``_on_timeout`` sits after ``if key == previous: return``. With the key dying
    per event the gate never matched, so a worker parked in API_TIMEOUT re-entered
    that branch on EVERY debounced flush — a repeated timeout handler and a
    repeated warning for one stall. Deduped, it runs once, on the transition in.
    """
    first = await _make_ap(WorkerStatus.API_TIMEOUT, monkeypatch)

    timeout_calls: list[None] = []

    async def _fake_timeout():
        timeout_calls.append(None)

    monkeypatch.setattr(type(first), "_on_timeout", lambda self: _fake_timeout(), raising=False)
    monkeypatch.setattr(type(first), "notify_updated", lambda self: asyncio.sleep(0), raising=False)

    await first.on_transcript_change(Path("/tmp/x.jsonl"), [])
    await first._debounce_task
    assert timeout_calls == [None]

    for _ in range(3):
        rehydrated = await AgenticProcess.get_by_id(str(first.id))
        assert rehydrated is not None
        await rehydrated.on_transcript_change(Path("/tmp/x.jsonl"), [])
        await rehydrated._debounce_task

    assert timeout_calls == [None], "the stall is unchanged — the handler must not re-fire"


@pytest.mark.long  # 1.02s
@pytest.mark.asyncio
async def test_flush_short_circuits_when_not_running(initialize_test_db, monkeypatch) -> None:
    """Lifecycle flipped to STOPPED during the debounce window → no broadcast."""
    ap = await _make_ap(WorkerStatus.COMPLETE, monkeypatch)
    object.__setattr__(ap, "_last_broadcast_key", None)

    notify_calls: list[None] = []

    async def _fake_notify():
        notify_calls.append(None)

    monkeypatch.setattr(type(ap), "notify_updated", lambda self: _fake_notify(), raising=False)

    await ap.on_transcript_change(Path("/tmp/x.jsonl"), [])
    ap.status = ProcessStatus.STOPPED.value
    await ap._debounce_task

    assert notify_calls == []


@pytest.mark.long  # 1.02s
@pytest.mark.asyncio
async def test_stale_pty_flush_cannot_overwrite_durable_cli_switch(initialize_test_db, monkeypatch) -> None:
    """A PTY callback armed before a CLI switch never republishes its stale row."""
    ap = await _make_ap(WorkerStatus.COMPLETE, monkeypatch)
    object.__setattr__(ap, "_last_broadcast_key", ("running", True, "thinking"))

    notify_snapshots: list[tuple[str, bool]] = []

    async def _fake_notify(entity: AgenticProcess) -> None:
        notify_snapshots.append((entity.status, entity.pty_mode))

    monkeypatch.setattr(type(ap), "notify_updated", _fake_notify, raising=False)

    await ap.on_transcript_change(Path("/tmp/x.jsonl"), [])
    durable = await AgenticProcess.get_by_id(str(ap.id))
    assert durable is not None
    durable.status = ProcessStatus.STOPPED.value
    durable.pty_mode = False
    durable.visible = False
    await durable.save(notify=False)

    await ap._debounce_task

    assert notify_snapshots == []
    persisted = await AgenticProcess.get_by_id(str(ap.id))
    assert persisted is not None
    assert persisted.status == ProcessStatus.STOPPED.value
    assert persisted.pty_mode is False


@pytest.mark.long  # 1.02s
@pytest.mark.asyncio
async def test_flush_invokes_on_timeout_for_api_timeout(initialize_test_db, monkeypatch) -> None:
    """API_TIMEOUT triggers _on_timeout — migrated responsibility from
    the deleted _poll_for_completion."""
    ap = await _make_ap(WorkerStatus.API_TIMEOUT, monkeypatch)
    object.__setattr__(ap, "_last_broadcast_key", ("running", True, "working"))

    timeout_calls: list[None] = []
    notify_calls: list[None] = []

    async def _fake_timeout():
        timeout_calls.append(None)

    async def _fake_notify():
        notify_calls.append(None)

    monkeypatch.setattr(type(ap), "_on_timeout", lambda self: _fake_timeout(), raising=False)
    monkeypatch.setattr(type(ap), "notify_updated", lambda self: _fake_notify(), raising=False)

    await ap.on_transcript_change(Path("/tmp/x.jsonl"), [])
    await ap._debounce_task

    assert timeout_calls == [None]
    assert notify_calls == [None]


@pytest.mark.asyncio
async def test_buffer_cap_drops_oldest_on_overflow(initialize_test_db, monkeypatch) -> None:
    """Pathological-writer protection — newest entries kept, oldest dropped."""
    ap = await _make_ap(WorkerStatus.THINKING, monkeypatch)

    big_chunk = list(range(ap._DEBOUNCE_BUFFER_CAP + 50))
    await ap.on_transcript_change(Path("/tmp/x.jsonl"), big_chunk)

    assert len(ap._pending_entries) == ap._DEBOUNCE_BUFFER_CAP
    assert ap._pending_entries[-1] == big_chunk[-1]
    ap._debounce_task.cancel()
    try:
        await ap._debounce_task
    except (asyncio.CancelledError, Exception):
        pass
