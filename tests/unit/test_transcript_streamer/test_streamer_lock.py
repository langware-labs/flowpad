"""TranscriptStreamer concurrency — concurrent ``notify_change`` calls
serialize via the per-streamer ``asyncio.Lock``; entries are delivered in order.

Real ``AgentTranscriptFile``, real parser, real tmp JSONL. No mocks.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from flow_sdk.transcript_streamer.streamer import TranscriptStreamer


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


def _write_jsonl(path: Path, n: int) -> None:
    """Append n minimal Claude session_meta lines to path (overwrites)."""
    with open(path, "wb") as f:
        for i in range(n):
            line = json.dumps({
                "type": "session_meta",
                "sessionId": f"00000000-0000-0000-0000-{i:012d}",
                "timestamp": "2026-05-22T00:00:00.000Z",
            }) + "\n"
            f.write(line.encode("utf-8"))


@pytest.mark.asyncio
async def test_concurrent_notify_change_serializes(tmp_path: Path) -> None:
    """N concurrent notify_change calls produce a coherent entry list — total
    entries equal to lines on disk, no duplicates, no losses.

    Each notify_change runs under the streamer's asyncio.Lock, so the
    sequence of (seek → read → feed → fold) operations interleaves cleanly.
    """
    jsonl = tmp_path / "session.jsonl"
    _write_jsonl(jsonl, n=20)

    streamer = TranscriptStreamer(jsonl, "claude")

    # Fire 10 concurrent notify_changes against the same file. The first one
    # consumes all bytes; the rest find no new bytes and return [].
    results = await asyncio.gather(*[streamer.notify_change() for _ in range(10)])

    total_emitted = sum(len(r) for r in results)
    assert total_emitted == len(streamer.transcript.entries) == 20

    # Exactly one call should have produced all 20 entries (the lock-winner);
    # the others should have produced [].
    nonempty = [r for r in results if r]
    assert len(nonempty) == 1
    assert len(nonempty[0]) == 20


@pytest.mark.asyncio
async def test_concurrent_with_appends_preserves_order(tmp_path: Path) -> None:
    """Concurrent notify_changes interleaved with appends still produce a
    monotonic, in-order entries list — entries[i].id is line i's id."""
    jsonl = tmp_path / "session.jsonl"
    _write_jsonl(jsonl, n=5)

    streamer = TranscriptStreamer(jsonl, "claude")
    await streamer.notify_change()  # flush initial 5

    # Append 5 more lines, then concurrently fire several notify_changes.
    with open(jsonl, "ab") as f:
        for i in range(5, 10):
            f.write((json.dumps({
                "type": "session_meta",
                "sessionId": f"00000000-0000-0000-0000-{i:012d}",
                "timestamp": "2026-05-22T00:00:00.000Z",
            }) + "\n").encode("utf-8"))

    await asyncio.gather(*[streamer.notify_change() for _ in range(8)])

    entries = streamer.transcript.entries
    assert len(entries) == 10
    # Line idx i passed to parser.feed monotonically increases — entries
    # appear in source-file order.
    ids = [getattr(e, "id", None) for e in entries]
    assert ids == sorted(ids)  # sortable here because we control session ids
