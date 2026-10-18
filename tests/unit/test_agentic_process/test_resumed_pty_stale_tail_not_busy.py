"""A PTY session resumed over a turn its PREVIOUS worker never finished is idle, not busy.

Session ``bd4ed17c`` (2026-10-15): closed mid-turn the evening before -- its
transcript ends on a tool_result, then ``last-prompt`` and ``cost-state`` with
no assistant reply. Reopened, ``claude --resume`` sat idle at its prompt, but it
keeps the closing "No response requested." in memory and only writes it with the
next user message. So for those fourteen minutes the tail on disk still read
mid-turn, ``is_turn_busy`` (PTY signal 4) answered ``busy=True``, and the client
greyed the Chat segment until a new turn wrote a terminal entry.

The tail is real (the exact shape the killed worker left) and the launch is
recorded through the same ``_record_worker_started_at`` the PTY ``open`` path
calls; ``busy`` is read through the ``status`` action, the wire's own answer.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

_CWD = "/tmp/flowpad-resumed-pty-stale-tail"


def _stamp(at: datetime) -> str:
    return at.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _append(path: Path, session_id: str, at: datetime, *entries: dict) -> None:
    with path.open("a", encoding="utf-8") as fh:
        for entry in entries:
            env = {"sessionId": session_id, "cwd": _CWD, "version": "2.1.300", "uuid": str(uuid.uuid4())}
            if entry.get("type") in ("user", "assistant"):
                env["timestamp"] = _stamp(at)
            fh.write(json.dumps({**env, **entry}) + "\n")


def _interrupted_turn(path: Path, session_id: str, at: datetime) -> None:
    """What a worker killed between a tool's result and its reply leaves behind."""
    tool_id = f"toolu_{uuid.uuid4().hex[:12]}"
    _append(
        path,
        session_id,
        at,
        {"type": "user", "message": {"role": "user", "content": "commit and push"}},
        {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "stop_reason": "tool_use",
                "content": [{"type": "tool_use", "id": tool_id, "name": "Bash", "input": {"command": "git push"}}],
            },
        },
        {
            "type": "user",
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": "ok"}]},
        },
        {"type": "last-prompt", "lastPrompt": "commit and push"},
        {"type": "cost-state", "totalCostUSD": 1.0},
    )


async def _resumed_pty_over_interrupted_turn() -> tuple[AgenticProcess, Path]:
    session_id = str(uuid.uuid4())
    project_dir = get_instance_settings().claude_projects_dir / _CWD.replace("/", "-")
    project_dir.mkdir(parents=True, exist_ok=True)
    path = project_dir / f"{session_id}.jsonl"
    path.write_text("", encoding="utf-8")
    now = datetime.now(timezone.utc)
    closed_at = now - timedelta(hours=14)
    _interrupted_turn(path, session_id, closed_at)
    os.utime(path, (closed_at.timestamp(), closed_at.timestamp()))  # last written when the old worker died

    ap = AgenticProcess(id=str(uuid.uuid4()), session_id=session_id, worker_type=WorkerType.CLAUDE_CODE)
    ap.status = ProcessStatus.RUNNING.value
    ap.pty_mode = True
    ap._record_worker_started_at(now.isoformat())  # the PTY open path's own record of the launch
    await ap.save(notify=False)
    return ap, path


@pytest.mark.asyncio
async def test_a_turn_the_previous_worker_left_open_does_not_make_the_resumed_session_busy(
    initialize_test_db,
) -> None:
    ap, _ = await _resumed_pty_over_interrupted_turn()

    status = (await ap.get_status()).data
    assert status["busy"] is False, (
        "the fresh worker is idle at its prompt; the mid-turn tail was written by the "
        f"worker before it, which is dead -- yet busy={status['busy']} "
        f"(worker_status={status['worker_status']}), so the Chat switch stays greyed"
    )


@pytest.mark.asyncio
async def test_a_turn_the_resumed_worker_starts_is_still_busy(initialize_test_db) -> None:
    """The control: the stale-tail rule must not blind ``busy`` to the live worker's own turn."""
    ap, path = await _resumed_pty_over_interrupted_turn()
    _append(
        path,
        ap.session_id,
        datetime.now(timezone.utc) + timedelta(seconds=1),
        {"type": "user", "message": {"role": "user", "content": "why can't I switch to chat?"}},
    )

    assert (await ap.get_status()).data["busy"] is True
