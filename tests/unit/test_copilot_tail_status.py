"""Copilot tail-status: ``assistant.turn_end`` means the turn is done and the
PTY sits at its prompt — IDLE, not THINKING. Mapping it to THINKING pinned
finished copilot sessions as perpetually busy (composer disabled, queue drain
blocked). The chat busy gate (``isWorkerRunning``) leans on this."""

import json

from flow_sdk.builtin.agentic_process.cli_drivers.copilot.status import copilot_tail_status
from flow_sdk.builtin.worker_status import WorkerStatus

_TURN = [
    {"type": "session.start", "data": {"sessionId": "s1"}},
    {"type": "user.message", "data": {"content": "hi"}},
    {"type": "assistant.message", "data": {"content": "hello"}},
    {"type": "assistant.turn_end", "data": {"turnId": "0"}},
]


def test_turn_end_is_idle(tmp_path):
    path = tmp_path / "events.jsonl"
    path.write_text("\n".join(json.dumps(e) for e in _TURN) + "\n")
    assert copilot_tail_status(path) == WorkerStatus.IDLE
