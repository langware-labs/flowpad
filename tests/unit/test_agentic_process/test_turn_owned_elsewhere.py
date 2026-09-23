"""A turn another OS process is running is ``busy`` in this one.

A local agent deployment runs its turns in its own process (``builtin/agent_loop``), while the app
serves ``busy`` to every client. Measured on a live instance: the app watched the turn's transcript
move working → tool_call → complete and still served ``busy=False`` throughout — so no client ever
opened ``observe-turn`` and the chat sat frozen until the reply. The runner's turn record, stamped
with its own pid, is what the app can read.

The record here is written by a REAL second Python process (``started_record()`` runs there), which
stays alive for the turn and is then killed — the crashed-loop case.
"""
from __future__ import annotations

import json
import subprocess
import sys

import pytest

from flow_sdk.builtin.agent_serve import TURNS, started_record
from flow_sdk.builtin.agentic_process import AgenticProcess, WorkerStatus
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy

RUNNER = (
    "import json, sys, time\n"
    "from flow_sdk.builtin.agent_serve import started_record\n"
    "print(json.dumps(started_record()), flush=True)\n"
    "time.sleep(60)\n"
)


@pytest.fixture
def runner():
    """Another OS process that has just taken a turn: its STARTED record, and the process itself."""
    proc = subprocess.Popen([sys.executable, "-c", RUNNER], stdout=subprocess.PIPE, text=True)
    try:
        record = json.loads(proc.stdout.readline())
        yield record, proc
    finally:
        proc.kill()
        proc.wait()


def _headless(record: dict) -> AgenticProcess:
    process = AgenticProcess()
    process.pty_mode = False
    process.context_data = {TURNS: {"src:msg:1": record}}
    return process


def test_a_turn_running_in_another_live_process_is_busy(runner):
    record, _ = runner
    assert is_turn_busy(_headless(record), WorkerStatus.TOOL_CALL) is True


def test_its_turn_ends_here_when_its_transcript_ends(runner):
    """The runner closes its record only after reading the reply; the app's last push must not say busy."""
    record, _ = runner
    assert is_turn_busy(_headless(record), WorkerStatus.COMPLETE) is False


def test_a_turn_whose_runner_died_is_not_busy(runner):
    """A loop that crashed mid-turn leaves its record STARTED — it must not pin busy forever."""
    record, proc = runner
    proc.kill()
    proc.wait()
    assert is_turn_busy(_headless(record), WorkerStatus.WORKING) is False


def test_the_runner_itself_answers_from_its_own_locks():
    """In the process that runs the turn, the record is not the signal — its prompt lock is."""
    assert is_turn_busy(_headless(started_record()), WorkerStatus.WORKING) is False
