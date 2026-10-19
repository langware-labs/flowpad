"""The turn-end reindex re-reads the WHOLE transcript on every turn.

Scope: this pins the watermark defect only.

  * ``_collect_touched_from_transcript_tail`` is meant to reindex just the
    turn's OWN new file-ops: it slices ``entries[wm:]`` with
    ``wm = self._reindex_entry_watermark``.
  * That watermark is a plain INSTANCE attribute, written with
    ``object.__setattr__(self, ...)``. ``_route_to_ap`` hydrates a FRESH
    ``AgenticProcess`` per streamer event (``AgenticProcess.local_rows``), so
    the write dies with the object and ``wm`` reads back 0 every time.
  * Consequence: turn 2 rescans turn 1 as well — and the cost is linear in
    transcript size, so a long session re-parses tens of thousands of entries
    on the event loop at every turn end, stalling every live terminal.
    Measured on prod 2026-09-20: a 50,557-entry session spent 1.1-2.1s per
    turn end with ``watermark=0 touched=507``.

  This is the SAME defect class as ``_last_broadcast_key``, one field over —
  see ``test_prompt_queue_drain_after_pty_turn.py``, whose fix was to move the
  value to a module-level, process-scoped store (``_LAST_BROADCAST_KEYS``).

No mocks: a real JSONL under the real (test-sandboxed) ``claude_projects_dir``,
dispatched through the real ``_route_to_ap`` subscriber, which re-hydrates the
AP per event exactly as the streamer does. The assertion reads the production
``turn_end_transcript_parse`` toplog line — the same line that attributed the
stalls on prod — so the test observes the reindex's real scan width, not an
internal attribute.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

from flow_sdk import toplog
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.transcript_subscriber import _route_to_ap
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

_CWD = "/tmp/flowpad-watermark"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _env(session_id: str) -> dict:
    return {"sessionId": session_id, "cwd": _CWD, "version": "2.0.0"}


def _append(path: Path, *entries: dict) -> None:
    with path.open("a", encoding="utf-8") as fh:
        for entry in entries:
            fh.write(json.dumps(entry) + "\n")


def _open_turn(path: Path, session_id: str, written_file: str) -> None:
    """The user asks and the agent Writes a file — turn still in flight
    (no ``stop_reason``), so a dispatch here records busy=True."""
    _append(
        path,
        {**_env(session_id), "type": "user", "uuid": str(uuid.uuid4()),
         "timestamp": _now_iso(),
         "message": {"role": "user", "content": f"write {written_file}"}},
        {**_env(session_id), "type": "assistant", "uuid": str(uuid.uuid4()),
         "timestamp": _now_iso(),
         "message": {"role": "assistant", "stop_reason": None, "content": [
             {"type": "tool_use", "id": f"toolu_{uuid.uuid4().hex[:12]}", "name": "Write",
              "input": {"file_path": written_file, "content": "hello\n"}},
         ]}},
    )


def _close_turn(path: Path, session_id: str) -> None:
    """The turn finishes cleanly — the busy->idle edge the seam fires on."""
    _append(
        path,
        {**_env(session_id), "type": "assistant", "uuid": str(uuid.uuid4()),
         "timestamp": _now_iso(),
         "message": {"role": "assistant", "stop_reason": "end_turn",
                     "content": [{"type": "text", "text": "Done."}]}},
    )


async def _settle(before: set[asyncio.Task]) -> None:
    """Await every task the production path spawned during this step."""
    current = asyncio.current_task()
    for _ in range(10):
        spawned = [
            t for t in asyncio.all_tasks()
            if t not in before and t is not current and not t.done()
            and t.get_name() != "worker-name-watch"
        ]
        if not spawned:
            return
        await asyncio.gather(*spawned, return_exceptions=True)


async def _dispatch(ap: AgenticProcess, path: Path) -> None:
    before = set(asyncio.all_tasks())
    await _route_to_ap(ap.session_id, path, [])
    await _settle(before)


_PARSE_LINE = re.compile(r"turn_end_transcript_parse .*watermark=(\d+) touched=(\d+)")


def _parses(caplog) -> list[tuple[int, int]]:
    """(watermark, touched) for each turn-end reindex the product logged."""
    out = []
    for rec in caplog.records:
        m = _PARSE_LINE.search(rec.getMessage())
        if m:
            out.append((int(m.group(1)), int(m.group(2))))
    return out


@pytest.mark.long  # 4.77s — four 1s debounce windows (_DEBOUNCE_SECONDS)
@pytest.mark.asyncio
async def test_a_turn_end_reindex_only_scans_its_own_turn(
    initialize_test_db, caplog,
) -> None:
    """Two turns, each writing one file. The second turn end must scan only the
    second turn's entries — not re-scan the first.

    Fails today: the watermark is an instance attribute and ``_route_to_ap``
    re-hydrates the AP per event, so ``watermark=0`` on every turn end and the
    scan re-reads the whole session.
    """
    session_id = str(uuid.uuid4())
    project_dir = get_instance_settings().claude_projects_dir / _CWD.replace("/", "-")
    project_dir.mkdir(parents=True, exist_ok=True)
    path = project_dir / f"{session_id}.jsonl"
    path.write_text("", encoding="utf-8")
    _open_turn(path, session_id, "/tmp/flowpad-watermark/file_a.md")

    ap = AgenticProcess(
        id=str(uuid.uuid4()),
        session_id=session_id,
        worker_type=WorkerType.CLAUDE_CODE,
    )
    ap.status = ProcessStatus.RUNNING.value
    ap.pty_mode = True
    await ap.save(notify=False)

    # Guard: busy for the honest reason (a live turn on a fresh transcript), so
    # the busy->idle edge below is real and not a stale-tail artifact.
    assert ap.fetch_worker_status() == WorkerStatus.THINKING

    toplog.enable()
    toplog.on("pty")
    try:
        # Records busy=True. The turn-end edge needs a previous busy to fire.
        await _dispatch(ap, path)

        with caplog.at_level("INFO", logger="toplog"):
            # Turn 1 ends (it wrote file_a).
            _close_turn(path, session_id)
            await _dispatch(ap, path)
            after_first = _parses(caplog)

            # Turn 2 runs and ends: it writes file_b, and nothing in it
            # touches file_a again.
            _open_turn(path, session_id, "/tmp/flowpad-watermark/file_b.md")
            await _dispatch(ap, path)
            _close_turn(path, session_id)
            await _dispatch(ap, path)
            all_parses = _parses(caplog)
    finally:
        toplog.disable()

    assert after_first, (
        "the turn-end seam never fired on turn 1 — no turn_end_transcript_parse "
        "line, so this test is not exercising the reindex at all"
    )
    second = all_parses[len(after_first):]
    assert second, "the turn-end seam never fired on turn 2"

    watermark, touched = second[-1]
    assert touched == 1, (
        f"turn 2's reindex rescanned the whole session: touched={touched} "
        f"(expected 1 — only file_b; file_a belongs to turn 1). "
        f"watermark={watermark}. all parses (watermark, touched) = {all_parses}"
    )
    assert watermark > 0, (
        f"the watermark did not survive the per-event re-hydration: "
        f"watermark={watermark}, so entries[0:] rescanned the whole transcript. "
        f"all parses (watermark, touched) = {all_parses}"
    )
