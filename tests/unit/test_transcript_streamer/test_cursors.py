"""TranscriptCursorStore + registry catch-up gating — persisted consumption
state across (simulated) restarts.

Real store files, real registry, real tmp JSONL files. No mocks.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.transcript_streamer.cursors import TranscriptCursorStore
from flow_sdk.transcript_streamer.registry import TranscriptStreamerRegistry

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


def _write_session_line(path: Path, session_id: str, text: str = "hi") -> None:
    line = json.dumps({
        "type": "user",
        "sessionId": session_id,
        "timestamp": "2026-06-10T00:00:00.000Z",
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    })
    with path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def _claude_jsonl(tmp_path: Path, name: str = "session.jsonl") -> Path:
    p = tmp_path / ".claude" / "projects" / "encoded-cwd" / name
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def test_store_roundtrip(tmp_path: Path) -> None:
    """update → flush → a NEW store instance sees the file as consumed."""
    store_path = tmp_path / "cursors.json"
    f = tmp_path / "a.jsonl"
    f.write_text("x\n", encoding="utf-8")
    st = f.stat()

    store = TranscriptCursorStore(store_path)
    assert not store.is_consumed(f, size=st.st_size, mtime_ns=st.st_mtime_ns)
    store.update(f, size=st.st_size, mtime_ns=st.st_mtime_ns)
    store.flush()

    reloaded = TranscriptCursorStore(store_path)
    assert reloaded.is_consumed(f, size=st.st_size, mtime_ns=st.st_mtime_ns)
    # A different size/mtime is not consumed.
    assert not reloaded.is_consumed(f, size=st.st_size + 1, mtime_ns=st.st_mtime_ns)


def test_store_corrupt_file_starts_empty(tmp_path: Path) -> None:
    store_path = tmp_path / "cursors.json"
    store_path.write_text("{not json", encoding="utf-8")
    store = TranscriptCursorStore(store_path)
    assert len(store) == 0


def test_flush_is_noop_when_clean(tmp_path: Path) -> None:
    store_path = tmp_path / "cursors.json"
    TranscriptCursorStore(store_path).flush()
    assert not store_path.exists()


def test_needs_catch_up_without_store_is_true(tmp_path: Path) -> None:
    reg = TranscriptStreamerRegistry()
    f = _claude_jsonl(tmp_path)
    _write_session_line(f, "s1")
    assert reg.needs_catch_up(f)


@pytest.mark.asyncio
async def test_consumed_file_skips_catch_up_across_restart(tmp_path: Path) -> None:
    """notify_change + flush → a fresh registry (new process) skips the file;
    appending new content makes it need catch-up again."""
    store_path = tmp_path / "cursors.json"
    f = _claude_jsonl(tmp_path)
    _write_session_line(f, "s1", "first")

    reg = TranscriptStreamerRegistry()
    reg.configure_cursors(store_path)
    assert reg.needs_catch_up(f)
    await reg.notify_change(f)
    assert not reg.needs_catch_up(f)
    await reg.flush_cursors()

    # Simulated restart: brand-new registry, same persisted store.
    reg2 = TranscriptStreamerRegistry()
    reg2.configure_cursors(store_path)
    assert not reg2.needs_catch_up(f)

    # File grows while "down" → needs catch-up again.
    _write_session_line(f, "s1", "second")
    assert reg2.needs_catch_up(f)


@pytest.mark.asyncio
async def test_missing_file_does_not_need_catch_up(tmp_path: Path) -> None:
    reg = TranscriptStreamerRegistry()
    reg.configure_cursors(tmp_path / "cursors.json")
    assert not reg.needs_catch_up(tmp_path / "gone.jsonl")
