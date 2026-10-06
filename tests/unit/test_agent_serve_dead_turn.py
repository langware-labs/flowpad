"""A turn whose runner died is read from its transcript as it stands, never waited on.

The regression: a hub's local box was restarted mid-turn. The redelivered message found the turn
STARTED by the dead loop and waited for the transcript's terminal marker -- which a killed worker
never writes -- so the message, and every message behind it, stalled for the whole budget.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin.agent_serve import OWNER_PID, STARTED, _left_reply
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus

pytestmark = pytest.mark.timeout(5)  # do not increase without approval


@pytest.fixture(scope="module")
def dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


class _Driver:
    name = "claude"

    def __init__(self, path, tail):
        self.path, self.tail = path, tail

    def transcript_descriptor(self, ap):
        return None

    def transcript_path(self, ap):
        return self.path

    def tail_status(self, path):
        return self.tail


class _Process:
    session_id = ""

    def __init__(self, path, tail=WorkerStatus.COMPLETE):
        self.driver = _Driver(path, tail)


def _transcript(tmp_path, reply="Three things I can do."):
    path = tmp_path / "s.jsonl"
    lines = [
        {"type": "user", "uuid": "u1", "message": {"role": "user", "content": "hi Flow"}},
        {"type": "assistant", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "text", "text": reply}]}},
    ]
    path.write_text("".join(json.dumps(line) + "\n" for line in lines))
    return path


def _started(pid, *, ago=timedelta(minutes=1)):
    return {"status": STARTED, OWNER_PID: pid, "at": (datetime.now(timezone.utc) - ago).isoformat()}


@pytest.fixture
def no_wait(monkeypatch):
    async def waits(ap):
        raise AssertionError("waited on a turn whose runner is gone")

    monkeypatch.setattr("flow_sdk.app.actions.execute_prompt._capture_assistant_reply", waits)


async def test_a_dead_runners_completed_turn_is_its_reply(tmp_path, dead_pid, no_wait):
    assert await _left_reply(_Process(_transcript(tmp_path)), _started(dead_pid)) == "Three things I can do."


async def test_a_dead_runners_unfinished_turn_left_no_reply(tmp_path, dead_pid, no_wait):
    assert await _left_reply(_Process(_transcript(tmp_path), WorkerStatus.WORKING), _started(dead_pid)) == ""


async def test_a_completed_tail_older_than_the_turn_is_the_previous_turns(tmp_path, dead_pid, no_wait):
    """The runner died before its worker wrote this turn: the COMPLETE tail is the turn before it."""
    path = _transcript(tmp_path)
    assert await _left_reply(_Process(path), _started(dead_pid, ago=-timedelta(minutes=1))) == ""


async def test_a_live_runners_turn_is_still_waited_for(tmp_path, monkeypatch):
    async def waits(ap):
        return "finished while we waited"

    monkeypatch.setattr("flow_sdk.app.actions.execute_prompt._capture_assistant_reply", waits)
    assert await _left_reply(_Process(_transcript(tmp_path)), _started(os.getpid())) == "finished while we waited"
