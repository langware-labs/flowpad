"""TranscriptStreamerRegistry eviction — both policies:

  * **PTY-tied**: ``remove(session_id)`` drops immediately.
  * **Idle TTL**: the background sweeper drops streamers whose
    ``last_activity`` is older than ``IDLE_TTL_SECONDS`` (production: 1h).
    Tests drive ``_evict_idle`` directly with a short TTL — exercising the
    actual TTL would require waiting 1h.
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from flow_sdk.transcript_streamer.registry import TranscriptStreamerRegistry


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


def _write_minimal(path: Path, sid: str) -> None:
    line = json.dumps({
        "type": "session_meta",
        "sessionId": sid,
        "timestamp": "2026-05-22T00:00:00.000Z",
    })
    path.write_text(line + "\n", encoding="utf-8")


def _claude_jsonl(tmp_path: Path, sid: str) -> Path:
    """Build a path that ``_infer_worker_type`` will recognize as Claude."""
    d = tmp_path / ".claude" / "projects" / "enc"
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{sid}.jsonl"
    _write_minimal(p, sid)
    return p


@pytest.mark.asyncio
async def test_pty_close_remove_drops_immediately(tmp_path: Path) -> None:
    sid = "99999999-9999-4999-8999-999999999999"
    jsonl = _claude_jsonl(tmp_path, sid)

    reg = TranscriptStreamerRegistry()
    await reg.notify_change(jsonl)
    assert len(reg) == 1

    # PTY-close hook calls remove(session_id). Streamer is dropped immediately,
    # regardless of last_activity recency.
    reg.remove(sid)
    assert len(reg) == 0


@pytest.mark.asyncio
async def test_evict_idle_drops_stale_streamers(tmp_path: Path) -> None:
    """_evict_idle(ttl=…) drops streamers whose last_activity is older than ttl."""
    sid = "88888888-8888-4888-8888-888888888888"
    jsonl = _claude_jsonl(tmp_path, sid)

    reg = TranscriptStreamerRegistry()
    await reg.notify_change(jsonl)
    streamer = reg.get_streamer(sid)
    assert streamer is not None

    # Backdate the streamer's last_activity to 10s ago.
    streamer.last_activity = time.monotonic() - 10.0

    evicted = reg._evict_idle(ttl=5.0)
    assert evicted == 1
    assert len(reg) == 0


@pytest.mark.asyncio
async def test_evict_idle_preserves_recent(tmp_path: Path) -> None:
    """A streamer touched within ttl is preserved by the sweeper."""
    sid_old = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    sid_recent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    jsonl_old = _claude_jsonl(tmp_path, sid_old)
    jsonl_recent = _claude_jsonl(tmp_path, sid_recent)

    reg = TranscriptStreamerRegistry()
    await reg.notify_change(jsonl_old)
    await reg.notify_change(jsonl_recent)

    reg.get_streamer(sid_old).last_activity = time.monotonic() - 100.0

    evicted = reg._evict_idle(ttl=5.0)
    assert evicted == 1
    assert reg.get_streamer(sid_old) is None
    assert reg.get_streamer(sid_recent) is not None


@pytest.mark.asyncio
async def test_start_stop_idle_sweeper_idempotent() -> None:
    """start_idle_sweeper() / stop_idle_sweeper() are safe to call repeatedly."""
    reg = TranscriptStreamerRegistry()
    await reg.start_idle_sweeper()
    first_task = reg._idle_sweeper
    assert first_task is not None and not first_task.done()

    # Second start while running is a no-op (same task).
    await reg.start_idle_sweeper()
    assert reg._idle_sweeper is first_task

    await reg.stop_idle_sweeper()
    assert reg._idle_sweeper is None

    # Second stop is a no-op.
    await reg.stop_idle_sweeper()
