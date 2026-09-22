"""The turn-end seam must not re-parse a transcript the streamer already holds.

``_collect_touched_from_transcript_tail`` called ``_load_transcript()``, whose
construction eagerly parses the WHOLE JSONL — on the event loop, at every turn
end. Measured on prod 2026-09-20 against the real 80MB session:
``parse_ms=945..1196`` out of a ``ms=947..1198`` block, i.e. ~99% of it, and
``scan_ms=2``. Every live terminal stalls together for that second.

The streamer already owns that exact object for the session: the registry
builds it once OFF-loop (``asyncio.to_thread``) and keeps it current with
``parse_delta``, and the turn-end seam runs inside the dispatch of that very
delta. Reusing it took the turn-end block from 955ms to 0-2ms on the real
transcript, and reverting put it back — the measured on/off switch.

Proxy note: this test asserts the seam REACHES the streamer's object (identity
+ the path guard), not the latency. The latency is not assertable without a
timing bound, which this repo does not allow; it was proven by the toggle above.

No mocks: the streamer is created by the real ``notify_change`` entry point the
FSOp watcher calls, and the AP is re-hydrated by the real subscriber path.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.transcript_streamer.registry import transcript_streamer_registry

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

_CWD = "/tmp/flowpad-streamed-transcript"


def _write_session(session_id: str) -> Path:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    env = {"sessionId": session_id, "cwd": _CWD, "version": "2.0.0"}
    proj = get_instance_settings().claude_projects_dir / _CWD.replace("/", "-")
    proj.mkdir(parents=True, exist_ok=True)
    path = proj / f"{session_id}.jsonl"
    path.write_text("\n".join(json.dumps(e) for e in [
        {**env, "type": "user", "uuid": str(uuid.uuid4()), "timestamp": now,
         "message": {"role": "user", "content": "go"}},
        {**env, "type": "assistant", "uuid": str(uuid.uuid4()), "timestamp": now,
         "message": {"role": "assistant", "stop_reason": "end_turn",
                     "content": [{"type": "text", "text": "done"}]}},
    ]) + "\n", encoding="utf-8")
    return path


async def _running_ap(session_id: str) -> AgenticProcess:
    ap = AgenticProcess(id=str(uuid.uuid4()), session_id=session_id,
                        worker_type=WorkerType.CLAUDE_CODE)
    ap.status = ProcessStatus.RUNNING.value
    ap.pty_mode = True
    await ap.save(notify=False)
    return ap


@pytest.mark.asyncio
async def test_the_turn_end_seam_reuses_the_streamers_parsed_transcript(
    initialize_test_db,
) -> None:
    session_id = str(uuid.uuid4())
    path = _write_session(session_id)
    ap = await _running_ap(session_id)

    # The FSOp watcher's own entry point: builds the streamer and parses once.
    await transcript_streamer_registry.notify_change(path)
    streamer = transcript_streamer_registry.get_streamer(session_id)
    assert streamer is not None, "the real entry point did not register a streamer"

    # A FRESH AgenticProcess, the way the subscriber hydrates one per event.
    fresh = await AgenticProcess.get_by_id(str(ap.id))
    assert fresh._current_transcript() is streamer.transcript, (
        "the turn-end seam built its own AgentTranscriptFile instead of reusing "
        "the streamer's — that construction is the whole-file eager parse"
    )

    transcript_streamer_registry.remove(session_id)


@pytest.mark.asyncio
async def test_a_process_with_no_streamer_falls_back_to_the_parse(
    initialize_test_db,
) -> None:
    """The common real case: a process restored after a restart, before the
    watcher has delivered its first delta. There is no streamer to reuse, so
    the seam must fall back rather than return an empty touched set."""
    session_id = str(uuid.uuid4())
    _write_session(session_id)
    ap = await _running_ap(session_id)

    assert transcript_streamer_registry.get_streamer(session_id) is None
    fresh = await AgenticProcess.get_by_id(str(ap.id))
    # Falls back to the parse rather than returning nothing, so no turn's
    # files are silently skipped while the streamer is still warming up.
    assert fresh._current_transcript() is not None
    assert fresh._current_transcript() is not fresh._current_transcript()
