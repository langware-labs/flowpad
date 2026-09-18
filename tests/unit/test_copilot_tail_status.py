"""Copilot tail-status: ``assistant.turn_end`` means the turn is done and the
PTY sits at its prompt — IDLE, not THINKING. Mapping it to THINKING pinned
finished copilot sessions as perpetually busy (composer disabled, queue drain
blocked). The chat busy gate (``isWorkerRunning``) leans on this."""

import json
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.status import copilot_tail_status
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus

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


@pytest.mark.parametrize("prefix,status,busy", [
    (3, WorkerStatus.INITIALIZING, True),
    (20, WorkerStatus.WORKING, True),
    (30, WorkerStatus.THINKING, True),
    (31, WorkerStatus.IDLE, False),
    (32, WorkerStatus.IDLE, False),
    (34, WorkerStatus.IDLE, False),
    (36, WorkerStatus.IDLE, False),
    (42, WorkerStatus.IDLE, False),
    (43, WorkerStatus.COMPLETE, False),
])
async def test_native_pty_bookkeeping_preserves_turn_status(tmp_path, monkeypatch, prefix, status, busy):
    # Copilot 1.0.83 browser capture: two real turns, shutdown, then idle resume.
    # Event order/status payloads retained; system prompts and telemetry removed.
    monkeypatch.setenv("FLOWPAD_COPILOT_HOME", str(tmp_path / "copilot"))
    reset_instance_settings()
    process = AgenticProcess(id=mint_uuid(), worker_type=WorkerType.COPILOT,
                             session_id="d9a04cec-8f3c-4bc7-8625-78b3eabb8ae2",
                             status="running", pty_mode=True)
    path = get_instance_settings().copilot_session_state_dir / process.session_id / "events.jsonl"
    path.parent.mkdir(parents=True)
    capture = Path(__file__).parent / "resources" / "transcripts" / "copilot_pty_status_1_0_83.jsonl"
    path.write_text("\n".join(capture.read_text().splitlines()[:prefix]) + "\n")
    response = await process.get_status()
    assert response.data["worker_status"] == status
    assert response.data["busy"] is busy
