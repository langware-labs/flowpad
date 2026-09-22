"""The transcript debounce must coalesce along the path the STREAMER takes.

`test_on_transcript_change` asserts coalescing by calling `on_transcript_change`
repeatedly on ONE `AgenticProcess` object. Production never does that:
`transcript_subscriber._route_to_ap` resolves the AP for each streamer event
through `AgenticProcess.local_rows(...)` -> `get_all`, and there is no identity
map, so **every event is delivered to a freshly hydrated instance**.

If the buffer and the debounce task live on the instance, each event therefore
gets its own buffer and its own timer, and the "one broadcast per quiescent
window" promise does not hold — N writes in a burst produce N flushes, each of
which re-reads and re-parses the transcript.

These tests drive the path the streamer actually drives.
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.naming.runtime import refresh_process_name
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

_JSONL = Path("/tmp/coalesce.jsonl")


async def _make_ap(monkeypatch) -> AgenticProcess:
    ap = AgenticProcess(
        id=str(uuid.uuid4()),
        session_id="00000000-0000-0000-0000-0000000000c1",
        worker_type=WorkerType.CLAUDE_CODE,
    )
    ap.status = ProcessStatus.RUNNING.value
    await ap.save(notify=False)
    await refresh_process_name(ap)
    monkeypatch.setattr(
        AgenticProcess,
        "_discover_status_from_transcript",
        lambda self: WorkerStatus.RUNNING,
        raising=False,
    )
    return ap


async def _settle_flushes() -> None:
    """Await every armed flush task, however the implementation holds it."""
    for _ in range(40):
        pending = [t for t in asyncio.all_tasks() if (t.get_name() or "").startswith("ap-flush-") and not t.done()]
        if not pending:
            break
        await asyncio.gather(*pending, return_exceptions=True)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_a_burst_delivered_to_fresh_instances_flushes_once(initialize_test_db, monkeypatch) -> None:
    """Three streamer events inside one debounce window = ONE flush.

    This is the whole point of the debounce: the streamer fires at filesystem
    speed, and each flush costs a transcript re-read plus a status report.
    """
    ap = await _make_ap(monkeypatch)

    flushed: list[str] = []
    original = AgenticProcess._flush_transcript_change

    async def counting(self):
        flushed.append(self.id)
        return await original(self)

    monkeypatch.setattr(AgenticProcess, "_flush_transcript_change", counting, raising=False)

    # Exactly what `_route_to_ap` does per event: hydrate, then deliver.
    for i in range(3):
        fresh = await AgenticProcess.get_by_id(ap.id)
        assert fresh is not None
        await fresh.on_transcript_change(_JSONL, [f"e{i}"])
    await _settle_flushes()

    assert len(flushed) == 1, f"a burst must coalesce into one flush, got {len(flushed)}"


@pytest.mark.asyncio
async def test_buffered_entries_survive_the_hydration_that_flushes(initialize_test_db, monkeypatch) -> None:
    """Entries buffered by one event must reach the flush armed by another.

    Each event carries its own slice of the transcript delta. If the buffer
    dies with the instance that received it, the flush sees only the last
    event's entries and every earlier file/plan event in the window is lost.
    """
    ap = await _make_ap(monkeypatch)

    seen: list[list] = []

    async def capture(self, entries):
        seen.append(list(entries))

    monkeypatch.setattr(AgenticProcess, "_process_transcript_entries", capture, raising=False)

    for i in range(3):
        fresh = await AgenticProcess.get_by_id(ap.id)
        assert fresh is not None
        await fresh.on_transcript_change(_JSONL, [f"e{i}"])
    await _settle_flushes()

    delivered = [entry for batch in seen for entry in batch]
    assert delivered == ["e0", "e1", "e2"], f"every buffered entry must reach a flush, got {delivered}"
