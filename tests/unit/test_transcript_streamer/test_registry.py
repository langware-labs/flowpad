"""TranscriptStreamerRegistry — subscribe/unsubscribe lifecycle, dispatch
failure isolation, worker inference, ``remove`` semantics.

Real registry, real streamer, real tmp JSONL files. No mocks.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from flow_sdk.transcript_streamer.registry import (
    TranscriptStreamerRegistry,
    _infer_worker_type,
)


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


def _write_minimal_session(path: Path, session_id: str) -> None:
    line = json.dumps({
        "type": "session_meta",
        "sessionId": session_id,
        "timestamp": "2026-05-22T00:00:00.000Z",
    })
    path.write_text(line + "\n", encoding="utf-8")


def test_infer_worker_type_claude(tmp_path: Path) -> None:
    """Anything under a ``.claude`` ancestor resolves to claude."""
    p = tmp_path / ".claude" / "projects" / "encoded-cwd" / "session.jsonl"
    p.parent.mkdir(parents=True)
    p.touch()
    assert _infer_worker_type(p) == "claude"


def test_infer_worker_type_codex(tmp_path: Path) -> None:
    p = tmp_path / ".codex" / "sessions" / "2026" / "05" / "rollout-x.jsonl"
    p.parent.mkdir(parents=True)
    p.touch()
    assert _infer_worker_type(p) == "codex"


def test_infer_worker_type_unknown(tmp_path: Path) -> None:
    p = tmp_path / "random" / "file.jsonl"
    p.parent.mkdir(parents=True)
    p.touch()
    with pytest.raises(ValueError):
        _infer_worker_type(p)


@pytest.mark.asyncio
async def test_subscribe_and_unsubscribe() -> None:
    """subscribe returns an unsub function that removes the callback."""
    reg = TranscriptStreamerRegistry()
    calls: list[tuple[str, Path, list[Any]]] = []

    async def cb(sid: str, path: Path, entries: list[Any]) -> None:
        calls.append((sid, path, entries))

    unsub = reg.subscribe("test", cb)
    assert "test" in reg._subscribers
    unsub()
    assert "test" not in reg._subscribers


@pytest.mark.asyncio
async def test_dispatch_failure_isolation(tmp_path: Path) -> None:
    """A subscriber that raises does not skip downstream subscribers."""
    # Build a registry-shaped path so _infer_worker_type accepts it.
    fake_claude_dir = tmp_path / ".claude" / "projects" / "encoded"
    fake_claude_dir.mkdir(parents=True)
    jsonl = fake_claude_dir / "deadbeef-cafe-1234-5678-000000000001.jsonl"
    _write_minimal_session(jsonl, "deadbeef-cafe-1234-5678-000000000001")

    reg = TranscriptStreamerRegistry()
    saw: list[str] = []

    async def crashy(sid: str, path: Path, entries: list[Any]) -> None:
        raise RuntimeError("intentional")

    async def survivor(sid: str, path: Path, entries: list[Any]) -> None:
        saw.append("survivor")

    reg.subscribe("crashy", crashy)
    reg.subscribe("survivor", survivor)

    await reg.notify_change(jsonl)
    # Survivor must have run despite crashy raising.
    assert saw == ["survivor"]


@pytest.mark.asyncio
async def test_remove_by_session_id_drops_streamer(tmp_path: Path) -> None:
    """``remove(session_id)`` finds + drops the streamer whose
    parser-resolved session_id matches."""
    sid = "11111111-1111-4111-8111-111111111111"
    fake_claude_dir = tmp_path / ".claude" / "projects" / "encoded"
    fake_claude_dir.mkdir(parents=True)
    jsonl = fake_claude_dir / f"{sid}.jsonl"
    _write_minimal_session(jsonl, sid)

    reg = TranscriptStreamerRegistry()
    await reg.notify_change(jsonl)
    assert len(reg) == 1

    reg.remove(sid)
    assert len(reg) == 0


@pytest.mark.asyncio
async def test_remove_by_path_drops_streamer(tmp_path: Path) -> None:
    sid = "22222222-2222-4222-8222-222222222222"
    fake_claude_dir = tmp_path / ".claude" / "projects" / "encoded"
    fake_claude_dir.mkdir(parents=True)
    jsonl = fake_claude_dir / f"{sid}.jsonl"
    _write_minimal_session(jsonl, sid)

    reg = TranscriptStreamerRegistry()
    await reg.notify_change(jsonl)
    assert len(reg) == 1

    reg.remove_by_path(jsonl)
    assert len(reg) == 0


@pytest.mark.asyncio
async def test_get_streamer_by_session_id(tmp_path: Path) -> None:
    """get_streamer(session_id) returns the streamer with that
    parser-resolved session_id."""
    sid = "33333333-3333-4333-8333-333333333333"
    fake_claude_dir = tmp_path / ".claude" / "projects" / "encoded"
    fake_claude_dir.mkdir(parents=True)
    jsonl = fake_claude_dir / f"{sid}.jsonl"
    _write_minimal_session(jsonl, sid)

    reg = TranscriptStreamerRegistry()
    await reg.notify_change(jsonl)

    s = reg.get_streamer(sid)
    assert s is not None
    assert s.session_id == sid
    assert s.jsonl_path == jsonl


@pytest.mark.asyncio
async def test_notify_change_unknown_worker_no_crash(tmp_path: Path) -> None:
    """A path that doesn't match any worker dir logs a warning and no-ops."""
    jsonl = tmp_path / "orphan.jsonl"
    jsonl.write_text("", encoding="utf-8")

    reg = TranscriptStreamerRegistry()
    # Should not raise.
    await reg.notify_change(jsonl)
    assert len(reg) == 0
