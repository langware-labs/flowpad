"""A PTY turn broadcasts ``busy=True`` when it starts, not when the debounce closes.

A PTY turn's busy edges used to come from the debounced flush alone, which
reads the transcript tail one second after the first write. A turn that
started AND ended inside that window never broadcast ``busy=True``: clients
held ``busy=false`` while the server's ``is_turn_busy`` read the mid-turn tail
as busy. A ``switch-mode`` sent in that gap was 409'd ("a turn is in flight"),
and the client's surface reconcile — which retries on the busy→idle edge —
never saw an edge to retry on, so the session stayed on the PTY
(vibe_return_from_terminal_reconcile / chat_terminal_switch_stress, 2026-10-03).

No mocks of the status derivation: a real JSONL under the test-sandboxed
``claude_projects_dir``, dispatched through the real ``_route_to_ap``
subscriber, which re-hydrates the AP per event the way the streamer does.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.agentic_process import _DEBOUNCE_TASKS
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
from flow_sdk.builtin.agentic_process.transcript_subscriber import _route_to_ap
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

_CWD = "/tmp/flowpad-pty-turn-start"


def _append(path: Path, session_id: str, *entries: dict) -> None:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    with path.open("a", encoding="utf-8") as fh:
        for entry in entries:
            env = {"sessionId": session_id, "cwd": _CWD, "version": "2.0.0", "uuid": str(uuid.uuid4()), "timestamp": now}
            fh.write(json.dumps({**env, **entry}) + "\n")


async def _idle_pty_process() -> tuple[AgenticProcess, Path]:
    """A running PTY session whose last turn ended cleanly — idle, as the
    client last saw it."""
    session_id = str(uuid.uuid4())
    project_dir = get_instance_settings().claude_projects_dir / _CWD.replace("/", "-")
    project_dir.mkdir(parents=True, exist_ok=True)
    path = project_dir / f"{session_id}.jsonl"
    path.write_text("", encoding="utf-8")
    _append(
        path,
        session_id,
        {"type": "user", "message": {"role": "user", "content": "first"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "end_turn",
                                          "content": [{"type": "text", "text": "done"}]}},
    )
    ap = AgenticProcess(id=str(uuid.uuid4()), session_id=session_id, worker_type=WorkerType.CLAUDE_CODE)
    ap.status = ProcessStatus.RUNNING.value
    ap.pty_mode = True
    await ap.save(notify=False)
    return ap, path


@pytest.mark.asyncio
async def test_a_pty_turn_broadcasts_busy_before_the_debounce_closes(initialize_test_db, monkeypatch) -> None:
    ap, path = await _idle_pty_process()
    assert not is_turn_busy(ap), "precondition: the session starts idle"

    broadcasts: list[bool] = []

    async def _record(self: AgenticProcess) -> None:
        broadcasts.append(is_turn_busy(self))

    monkeypatch.setattr(AgenticProcess, "notify_updated", _record)

    # The user types into the xterm: the turn's first write lands.
    _append(path, ap.session_id, {"type": "user", "message": {"role": "user", "content": "second"}})
    await _route_to_ap(ap.session_id, path, [])
    assert broadcasts == [True], (
        "the turn's start must reach clients now — waiting for the debounce lets a "
        f"turn shorter than the window pass with no busy edge at all: {broadcasts}"
    )

    # More writes in the same turn do not repeat the edge.
    _append(path, ap.session_id, {"type": "assistant", "message": {"role": "assistant", "stop_reason": None,
                                                                   "content": [{"type": "text", "text": "wor"}]}})
    await _route_to_ap(ap.session_id, path, [])
    assert broadcasts == [True]

    flush = _DEBOUNCE_TASKS.get(str(ap.id))
    if flush is not None:
        flush.cancel()
        try:
            await flush
        except (asyncio.CancelledError, Exception):
            pass


@pytest.mark.asyncio
async def test_a_headless_session_is_left_to_its_prompt_path(initialize_test_db, monkeypatch) -> None:
    """Control: headless turns broadcast their own edges from the prompt path,
    so the leading edge stays PTY-only."""
    ap, path = await _idle_pty_process()
    ap.pty_mode = False
    await ap.save(notify=False)

    broadcasts: list[bool] = []

    async def _record(self: AgenticProcess) -> None:
        broadcasts.append(is_turn_busy(self))

    monkeypatch.setattr(AgenticProcess, "notify_updated", _record)

    _append(path, ap.session_id, {"type": "user", "message": {"role": "user", "content": "second"}})
    await _route_to_ap(ap.session_id, path, [])
    assert broadcasts == []

    flush = _DEBOUNCE_TASKS.get(str(ap.id))
    if flush is not None:
        flush.cancel()
        try:
            await flush
        except (asyncio.CancelledError, Exception):
            pass
