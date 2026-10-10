"""Startup catch-up releases what nobody reads.

``TranscriptStreamerRegistry.catch_up`` delivers a pending file's entries
and keeps the parsed streamer only when a subscriber claimed the session.
The walk in ``flow_sdk.server.app._transcript_catch_up_walk`` enters through
it, so a fresh instance no longer parks a parsed copy of every transcript on
the machine until the idle TTL.

Real registry, real streamers, real tmp JSONL files, the real walk. The only
substitution is the subscriber (the product one needs a database row to
claim anything), which is the boundary the return value crosses.
"""
from __future__ import annotations

import gc
import json
import tracemalloc
from pathlib import Path
from typing import Any

import pytest

from flow_sdk.server import app as app_mod  # imported here so its load is not timed as the walk
from flow_sdk.server.routes.bootstrap import first_bootstrap_served
from flow_sdk.transcript_streamer.registry import TranscriptStreamerRegistry

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


def _write_session(path: Path, session_id: str, turns: int = 40) -> None:
    """A Claude-shaped session with ``turns`` user/assistant pairs (~500 B each)."""
    lines = []
    for t in range(turns):
        lines.append({
            "type": "user", "sessionId": session_id, "uuid": f"u-{t}",
            "timestamp": "2026-06-10T00:00:00.000Z",
            "message": {"role": "user", "content": [{"type": "text", "text": f"step {t} " + "lorem " * 40}]},
        })
        lines.append({
            "type": "assistant", "sessionId": session_id, "uuid": f"a-{t}",
            "timestamp": "2026-06-10T00:00:01.000Z",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "ipsum " * 60}]},
        })
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(line) + "\n" for line in lines), encoding="utf-8")


def _claude_jsonl(root: Path, session_id: str) -> Path:
    return root / ".claude" / "projects" / "encoded-cwd" / f"{session_id}.jsonl"


async def test_catch_up_unclaimed_dispatches_and_releases(tmp_path: Path) -> None:
    """No subscriber claims the session: entries are delivered, the cursor
    row exists, and the registry holds nothing afterwards."""
    sid = "41111111-1111-4111-8111-111111111111"
    jsonl = _claude_jsonl(tmp_path, sid)
    _write_session(jsonl, sid)

    reg = TranscriptStreamerRegistry()
    reg.configure_cursors(tmp_path / "cursors.json")
    delivered: list[int] = []

    async def unclaiming(_sid: str, _path: Path, entries: list[Any]) -> None:
        delivered.append(len(entries))

    reg.subscribe("probe", unclaiming)
    await reg.catch_up(jsonl)

    assert delivered and delivered[0] > 0
    assert not reg.needs_catch_up(jsonl)  # the cursor row is the "consumed" fact
    assert len(reg) == 0
    assert reg.get_streamer_by_path(jsonl) is None


async def test_catch_up_claimed_keeps_streamer(tmp_path: Path) -> None:
    """A subscriber that returns True owns the session: the streamer stays so
    the owner's next read does not re-parse the file on the event loop."""
    sid = "42222222-2222-4222-8222-222222222222"
    jsonl = _claude_jsonl(tmp_path, sid)
    _write_session(jsonl, sid)

    reg = TranscriptStreamerRegistry()

    async def claiming(_sid: str, _path: Path, _entries: list[Any]) -> bool:
        return True

    reg.subscribe("owner", claiming)
    await reg.catch_up(jsonl)

    assert reg.get_streamer_by_path(jsonl) is not None
    assert len(reg) == 1


async def test_catch_up_leaves_existing_streamer_alone(tmp_path: Path) -> None:
    """A streamer that a live event built before the walk reached the file is
    not the walk's to drop, claimed or not."""
    sid = "43333333-3333-4333-8333-333333333333"
    jsonl = _claude_jsonl(tmp_path, sid)
    _write_session(jsonl, sid)

    reg = TranscriptStreamerRegistry()

    async def unclaiming(_sid: str, _path: Path, _entries: list[Any]) -> None:
        return None

    reg.subscribe("probe", unclaiming)
    await reg.notify_change(jsonl)  # the live path
    live = reg.get_streamer_by_path(jsonl)
    assert live is not None

    await reg.catch_up(jsonl)
    assert reg.get_streamer_by_path(jsonl) is live


async def test_notify_change_reports_claim_from_any_subscriber(tmp_path: Path) -> None:
    """``notify_change`` is True when any subscriber claims, False when none
    does, and a raising subscriber counts as not claiming."""
    sid = "44444444-4444-4444-8444-444444444444"
    jsonl = _claude_jsonl(tmp_path, sid)
    _write_session(jsonl, sid, turns=2)

    reg = TranscriptStreamerRegistry()

    async def crashy(_sid: str, _path: Path, _entries: list[Any]) -> bool:
        raise RuntimeError("intentional")

    async def quiet(_sid: str, _path: Path, _entries: list[Any]) -> None:
        return None

    reg.subscribe("crashy", crashy)
    reg.subscribe("quiet", quiet)
    assert await reg.notify_change(jsonl) is False

    async def owner(_sid: str, _path: Path, _entries: list[Any]) -> bool:
        return True

    reg.subscribe("owner", owner)
    await reg.force_reparse(sid)  # re-emit history through _dispatch
    _write_session(jsonl, sid, turns=3)  # grow the file so there is a delta
    assert await reg.notify_change(jsonl) is True


@pytest.fixture
def walk_registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Point the instance at a tmp Claude home holding unowned sessions and
    hand the product registry singleton a fresh cursor store and a probe
    subscriber for the duration of the test."""
    from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings
    from flow_sdk.transcript_streamer import transcript_streamer_registry as reg

    claude_home = tmp_path / ".claude"
    monkeypatch.setenv("FLOWPAD_CLAUDE_HOME", str(claude_home))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude_home))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / ".codex"))
    reset_instance_settings()
    settings = get_instance_settings()
    assert settings.claude_projects_dir == claude_home / "projects"

    saved_subscribers = dict(reg._subscribers)
    saved_cursors = reg._cursors
    reg._subscribers.clear()
    reg.configure_cursors(tmp_path / "cursors.json")
    try:
        yield reg, settings
    finally:
        reg._subscribers.clear()
        reg._subscribers.update(saved_subscribers)
        reg._cursors = saved_cursors
        reset_instance_settings()


async def test_catch_up_walk_retains_nothing_for_unowned_sessions(walk_registry) -> None:
    """Enter where the product enters: ``_transcript_catch_up_walk`` on a fresh
    instance (no cursor file) over sessions no process owns. After it returns
    the registry is as empty as before, the heap holds no parsed transcript,
    and a second walk on the same cursors parses nothing."""
    reg, settings = walk_registry
    delivered = {"files": 0, "entries": 0}

    async def probe(_sid: str, _path: Path, entries: list[Any]) -> None:
        delivered["files"] += 1
        delivered["entries"] += len(entries)

    reg.subscribe("probe", probe)
    first_bootstrap_served.set()

    # Warm-up: one tiny session through the same walk, so the lazy parser
    # imports and the cursor file's first write are not counted below.
    warm = settings.claude_projects_dir / "warm" / "45000000-0000-4000-8000-000000000000.jsonl"
    _write_session(warm, warm.stem, turns=1)
    await app_mod._transcript_catch_up_walk()
    assert delivered["files"] == 1
    delivered.update(files=0, entries=0)

    paths = []
    for i in range(3):
        sid = f"4555555{i}-5555-4555-8555-555555555555"
        jsonl = settings.claude_projects_dir / f"encoded-{i}" / f"{sid}.jsonl"
        _write_session(jsonl, sid, turns=200)  # ~240 KB each
        paths.append(jsonl)
    before = len(reg)

    tracemalloc.start(1)
    try:
        gc.collect()
        base = tracemalloc.get_traced_memory()[0]
        await app_mod._transcript_catch_up_walk()
        gc.collect()
        retained = tracemalloc.get_traced_memory()[0] - base
    finally:
        tracemalloc.stop()

    assert delivered["files"] == 3 and delivered["entries"] >= 3 * 400
    assert len(reg) == before
    assert all(reg.get_streamer_by_path(p) is None for p in paths)
    # Stock code kept ~3x the bytes on disk per file (720 KB on disk here ->
    # ~2 MB). What is left is the three cursor rows and log records.
    assert retained < 200_000, f"{retained} bytes retained after the walk"

    calls = {"n": 0}
    real = reg.catch_up

    async def counting(path: Path) -> None:
        calls["n"] += 1
        await real(path)

    reg.catch_up = counting  # type: ignore[method-assign]
    try:
        await app_mod._transcript_catch_up_walk()
    finally:
        del reg.catch_up
    assert calls["n"] == 0
