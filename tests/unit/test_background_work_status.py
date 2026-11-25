"""A turn that ended with background work still running is not a finished session.

The transcript tail reads ``complete`` the moment the turn ends, while a
background command or subagent the turn launched is still going. Claude's
``Stop`` hook carries its own list of that work; the process reads as
``background_work`` until a later ``Stop`` reports the list empty.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcessContextKey
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus

# The ``background_tasks`` of a real ``Stop`` payload (claude 2.1.332, interactive).
RUNNING = [
    {"id": "a1c50d27bf32ea847", "type": "subagent", "status": "running", "description": "Run sleep 25 and report", "agent_type": "Explore"},
    {"id": "b09jt2leb", "type": "shell", "status": "running", "description": "Sleep 40 seconds", "command": "sleep 40"},
]


@pytest.fixture
def no_side_effects(monkeypatch):
    async def save(entity):
        return entity

    async def emit(_self, _flow_data):
        return None

    monkeypatch.setattr(AgenticProcess, "save", save)
    monkeypatch.setattr(AgenticProcess, "emit_flow_data", emit)


def _stop(process_id: str, tasks: list[dict]) -> AgentHookData:
    raw = {"hook_event_name": "Stop", "background_tasks": tasks, "session_crons": []}
    return AgentHookData(agentic_process_id=process_id, hook_data={"hook_event_name": "Stop", "raw_hook_data": raw})


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_side_effects")
async def test_ended_turn_reads_as_background_work_until_the_work_ends():
    process = AgenticProcess(id=mint_uuid(), worker_type="claude_code", status="running", pty_mode=True)
    process.enable_worker_report_hooks()
    assert "Stop" in process.process_hook_events
    pid = str(process.id)

    with patch.object(AgenticProcess, "_discover_status_from_transcript", return_value=WorkerStatus.COMPLETE):
        assert process.fetch_worker_status() is WorkerStatus.COMPLETE

        await process.on_hook(_stop(pid, RUNNING))
        assert [t["type"] for t in process.background_tasks()] == ["subagent", "shell"]
        assert process.fetch_worker_status() is WorkerStatus.BACKGROUND_WORK

        await process.on_hook(_stop(pid, RUNNING[1:]))  # the subagent ended and woke the worker
        assert process.fetch_worker_status() is WorkerStatus.BACKGROUND_WORK

        await process.on_hook(_stop(pid, []))
        assert process.fetch_worker_status() is WorkerStatus.COMPLETE


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_side_effects")
async def test_background_work_does_not_outlive_its_worker_or_hide_a_running_turn():
    process = AgenticProcess(id=mint_uuid(), worker_type="claude_code", status="running", pty_mode=True)
    process.enable_worker_report_hooks()
    await process.on_hook(_stop(str(process.id), RUNNING))

    with patch.object(AgenticProcess, "_discover_status_from_transcript", return_value=WorkerStatus.THINKING):
        assert process.fetch_worker_status() is WorkerStatus.THINKING  # the next turn is running

    process._record_worker_started_at("2026-11-25T12:00:00+00:00")  # the worker was restarted
    with patch.object(AgenticProcess, "_discover_status_from_transcript", return_value=WorkerStatus.COMPLETE):
        assert process.background_tasks() == []
        assert process.fetch_worker_status() is WorkerStatus.COMPLETE
    assert AgenticProcessContextKey.WORKER_STARTED_AT.value in process.context_data
