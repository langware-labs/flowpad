"""``stream_transcript`` resume guard (``prompt_worker_active``).

On a resumed multi-turn headless session the JSONL already ends with the PRIOR
turn's terminal marker, so the stream would exit before the new turn is written
and the caller captures the prior turn's reply (the multi-turn off-by-one).
``stream_transcript`` suppresses a terminal marker WHILE this process's turn
worker is still registered (``prompt_worker_active``) — so it waits for THIS
turn to actually run and write, then exits on the new turn.

Deterministic: a fake driver whose ``tail_status`` is COMPLETE from the very
first poll (the stale prior-turn marker); a live worker is registered for the
process id and a background task unregisters it after appending the new turn.
Real ``AgenticProcess.stream_transcript`` bound to a fake self."""

from __future__ import annotations

import asyncio
import json

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import (
    AgenticProcess,
    register_prompt_worker,
    unregister_prompt_worker,
)
from flow_sdk.builtin.worker_status import WorkerStatus

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


class _FakeDriver:
    def __init__(self, path):
        self._p = path

    def transcript_path(self, proc):
        return self._p

    def tail_status(self, path):
        # The stale PRIOR-turn terminal marker: terminal from the first poll.
        return WorkerStatus.COMPLETE


class _FakeAP:
    def __init__(self, path, ap_id="ap-resume-guard"):
        self.id = ap_id
        self.driver = _FakeDriver(path)


def _user(text):
    return json.dumps({"message": {"role": "user", "content": text}}) + "\n"


def _assistant(mid, text):
    return json.dumps(
        {"message": {"role": "assistant", "id": mid, "content": [{"type": "text", "text": text}]}}
    ) + "\n"


def _texts(entries):
    return [
        b.get("text")
        for e in entries
        for b in ((e.get("message") or {}).get("content") or [])
        if isinstance(b, dict)
    ]


async def _drain(ap, **kw):
    return [e async for e in AgenticProcess.stream_transcript(ap, poll_interval=0.05, **kw)]


async def test_guard_waits_for_the_new_turn(tmp_path):
    """A live worker is registered (turn in flight). The stale COMPLETE marker
    must NOT end the stream until the worker unregisters — by which point the
    new turn has been appended, so the stream sees NEW."""
    f = tmp_path / "t.jsonl"
    f.write_text(_user("q1") + _assistant("m1", "PRIOR"))  # prior turn, terminal present
    ap = _FakeAP(f)
    sentinel = object()
    register_prompt_worker(ap.id, sentinel)

    async def run_turn():
        await asyncio.sleep(3.0)  # turn "runs" (> the 2s terminal settle)
        with open(f, "a", encoding="utf-8") as fh:
            fh.write(_user("q2") + _assistant("m2", "NEW"))
        unregister_prompt_worker(ap.id, sentinel)  # turn done → guard releases

    task = asyncio.create_task(run_turn())
    try:
        entries = await _drain(ap, timeout=20)
    finally:
        unregister_prompt_worker(ap.id, sentinel)  # cleanup if the test raised
    await task

    texts = _texts(entries)
    assert "NEW" in texts, f"guard exited before the new turn was written: {texts}"


async def test_without_worker_exits_on_stale_marker(tmp_path):
    """Negative control: with NO live worker, the stream exits on the stale
    prior-turn terminal and never sees the late write — the bug the guard fixes
    (and the correct behavior when there is genuinely no turn in flight)."""
    f = tmp_path / "t.jsonl"
    f.write_text(_user("q1") + _assistant("m1", "PRIOR"))
    ap = _FakeAP(f, ap_id="ap-no-worker")  # nothing registered → not active

    async def late_write():
        await asyncio.sleep(3.0)  # > the 2s settle: the stream has already exited
        with open(f, "a", encoding="utf-8") as fh:
            fh.write(_user("q2") + _assistant("m2", "NEW"))

    task = asyncio.create_task(late_write())
    entries = await _drain(ap, timeout=20)
    await task

    texts = _texts(entries)
    assert texts == ["PRIOR"], f"expected only the stale prior turn, got {texts}"
