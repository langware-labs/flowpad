"""FLOWPAD-1981 — the prompt queue did not drain in PTY mode.

Scope: this pins the PTY drain defect only.

  * The turn-end seam is the busy→idle EDGE in ``_flush_transcript_change``,
    ``if not current_busy and prev_busy:``. ``prev_busy`` comes from
    ``_last_broadcast_key``, which was a plain INSTANCE attribute — and
    ``_route_to_ap`` hydrates a FRESH ``AgenticProcess`` per streamer event, so
    it always read back ``None`` and the edge never fired. That is the cause.
  * Nothing else covered for it. ``end_headless_turn`` schedules the
    ``complete`` drain — its docstring says that edge "is what actually
    advances a multi-entry queue (VIBE-005)" — but it runs on headless turns
    only, and so does the ``submit`` drain (a live PTY returns after sending
    Enter, before reaching it). ``chain`` needs a successful pop it can never
    get. ``enqueue`` always declines, because you only queue while busy.
  * Supporting, not the cause: that enqueue-time decline is terminal.
    ``_maybe_drain_queue`` bails ``not_ready`` with a bare ``return`` INSIDE
    the per-process lock, above the ``try/finally`` that schedules ``chain``,
    so a drain that declines cannot reschedule itself.

  ⇒ headless self-heals on its turn end; in PTY the queue never drained at all.

Deliberately NOT in scope: the stale-``last-prompt``-tail wedge that pins
``busy`` True forever. This test uses a FRESH transcript and asserts, before
and after, that the tail classifies honestly (THINKING mid-turn → COMPLETE at
the end). If either guard ever trips, the failure is that other defect and not
this one.

No mocks: a real JSONL under the real (test-sandboxed) ``claude_projects_dir``,
dispatched through the real ``_route_to_ap`` subscriber — which re-hydrates the
AP per event exactly as the streamer does, so the ``ready`` edge only sees a
previous ``busy`` if the process-scoped broadcast key really carried it across
that re-hydration.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
from flow_sdk.builtin.agentic_process.transcript_subscriber import _route_to_ap
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.builtin.worker_status import WorkerStatus
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

_CWD = "/tmp/flowpad-1981"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _env(session_id: str) -> dict:
    return {"sessionId": session_id, "cwd": _CWD, "version": "2.0.0"}


def _append(path: Path, *entries: dict) -> None:
    with path.open("a", encoding="utf-8") as fh:
        for entry in entries:
            fh.write(json.dumps(entry) + "\n")


def _write_live_mid_turn_session(session_id: str) -> Path:
    """A healthy PTY session that is genuinely mid-turn RIGHT NOW: the user
    prompted and the assistant is composing its reply (no ``stop_reason`` yet).
    Written with current timestamps — nothing here is stale."""
    project_dir = get_instance_settings().claude_projects_dir / _CWD.replace("/", "-")
    project_dir.mkdir(parents=True, exist_ok=True)
    path = project_dir / f"{session_id}.jsonl"
    path.write_text("", encoding="utf-8")
    _append(
        path,
        {**_env(session_id), "type": "user", "uuid": str(uuid.uuid4()),
         "timestamp": _now_iso(),
         "message": {"role": "user", "content": "run the build"}},
        {**_env(session_id), "type": "assistant", "uuid": str(uuid.uuid4()),
         "timestamp": _now_iso(),
         "message": {"role": "assistant", "stop_reason": None,
                     "content": [{"type": "text", "text": "Starting the build"}]}},
    )
    return path


def _append_turn_end(path: Path, session_id: str) -> None:
    """The turn finishes cleanly — Claude writes its terminal ``end_turn``."""
    _append(
        path,
        {**_env(session_id), "type": "assistant", "uuid": str(uuid.uuid4()),
         "timestamp": _now_iso(),
         "message": {"role": "assistant", "stop_reason": "end_turn",
                     "content": [{"type": "text", "text": "Build finished."}]}},
    )


async def _running_pty_process_mid_turn() -> tuple[AgenticProcess, Path]:
    session_id = str(uuid.uuid4())
    path = _write_live_mid_turn_session(session_id)
    ap = AgenticProcess(
        id=str(uuid.uuid4()),
        session_id=session_id,
        worker_type=WorkerType.CLAUDE_CODE,
    )
    ap.status = ProcessStatus.RUNNING.value
    ap.pty_mode = True
    await ap.save(notify=False)
    return ap, path


async def _settle(before: set[asyncio.Task]) -> None:
    """Await every task the production path spawned during this step — the
    debounced flush and anything it schedules. Only tasks that did not exist
    beforehand are awaited, so this can never block on the test runner's own."""
    current = asyncio.current_task()
    for _ in range(10):
        spawned = [
            t for t in asyncio.all_tasks()
            if t not in before and t is not current and not t.done()
        ]
        if not spawned:
            return
        await asyncio.gather(*spawned, return_exceptions=True)


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.pty_queue_drain.rules: FAILING? the prompt queue did not drain
#       in PTY mode - read this tag's rules before touching the turn-end edge or _last_broadcast_key
# flowpad:endcapsule tag
@pytest.mark.long  # 2.10s
@pytest.mark.asyncio
async def test_prompt_queued_during_a_pty_turn_drains_when_the_turn_ends(
    initialize_test_db,
) -> None:
    """Queue a prompt while a PTY agent is working; when that turn ends the
    prompt must run.

    Fails today: the enqueue-time drain correctly declined (the agent WAS
    busy), and no later event ever retries it.
    """
    ap, path = await _running_pty_process_mid_turn()

    # Guard (keeps the stale-tail defect out of scope): the agent is busy for
    # the honest reason — a live turn on a fresh transcript.
    assert ap.fetch_worker_status() == WorkerStatus.THINKING

    # The streamer fires on the turn's OWN writes, not only on its end — that
    # mid-turn flush is what records ``busy=True`` and is why the UI can show
    # the agent as working at all. Dispatch it here for the same reason the
    # user can only queue "while busy" once they have been told so.
    before_mid = set(asyncio.all_tasks())
    await _route_to_ap(ap.session_id, path, [])
    await _settle(before_mid)

    ap.queue.enqueue("queued while busy", source="ui")
    await ap._maybe_drain_queue("enqueue")
    assert [e["prompt"] for e in ap.queue.entries] == ["queued while busy"], (
        "the enqueue-time drain should decline while the turn is in flight"
    )

    # The PTY turn really ends.
    _append_turn_end(path, ap.session_id)

    # Guard (again, stale tail is not what this test is about): the turn end
    # registered honestly, so the agent is genuinely free to take the prompt.
    # Read BEFORE dispatching — once the drain fires it calls prompt(), which
    # cannot boot a real worker in this sandbox and leaves its own mark on the
    # row. What matters here is that the transcript itself says "idle".
    at_turn_end = ap.fetch_worker_status()
    assert at_turn_end == WorkerStatus.COMPLETE
    assert not is_turn_busy(ap, at_turn_end)

    # The streamer dispatches the delta the way production does.
    before = set(asyncio.all_tasks())
    await _route_to_ap(ap.session_id, path, [])
    await _settle(before)

    # Proxy assertion: we assert the queue was consumed, not that the worker
    # produced output — `_maybe_drain_queue` pop-persists the head before it
    # injects, and no real PTY can be spawned here.
    fresh = await AgenticProcess.get_by_id(str(ap.id))
    remaining = [e["prompt"] for e in fresh.queue.entries]
    drain_checks = [
        (e.get("source"), e.get("reason"))
        for e in fresh.queue.log_entries()
        if e.get("action") == "drain_check"
    ]
    assert remaining == [], (
        f"the prompt queued mid-turn was never drained after the turn ended: "
        f"still {remaining}; drain_check={drain_checks}; "
        f"worker_status at turn end={at_turn_end}"
    )
    # ...and specifically from the turn-end seam. No other drain source is
    # reachable for a live PTY, so anything else popping it would mean the
    # scenario, not the fix, changed.
    assert ("ready", "ok") in drain_checks, (
        f"the queue drained, but not from the turn-end seam: {drain_checks}"
    )


@pytest.mark.asyncio
async def test_headless_control_the_same_prompt_drains_on_its_turn_end(
    initialize_test_db,
) -> None:
    """Control for the test above — the transport is the switch.

    Identical scenario with ``pty_mode=False``: a headless turn ends through
    ``end_headless_turn``, which schedules the ``complete`` drain, so the
    prompt queued mid-turn DOES run. Passing today. This is what the PTY side
    is missing, and it is why the defect is PTY-only.
    """
    ap, _path = await _running_pty_process_mid_turn()
    ap.pty_mode = False
    await ap.save(notify=False)

    ap.queue.enqueue("queued while busy", source="ui")
    # Mid-turn for a headless turn is the in-flight override, not the tail.
    object.__setattr__(ap, "_turn_in_flight", True)
    await ap._maybe_drain_queue("enqueue")
    assert [e["prompt"] for e in ap.queue.entries] == ["queued while busy"], (
        "the enqueue-time drain should decline while the headless turn is in flight"
    )

    before = set(asyncio.all_tasks())
    await ap.end_headless_turn("test")
    await _settle(before)

    remaining = [e["prompt"] for e in ap.queue.entries]
    drain_checks = [
        (e.get("source"), e.get("reason"))
        for e in ap.queue.log_entries()
        if e.get("action") == "drain_check"
    ]
    assert remaining == [], (
        f"headless should self-heal on its turn end but did not: still "
        f"{remaining}; drain_check={drain_checks}"
    )
