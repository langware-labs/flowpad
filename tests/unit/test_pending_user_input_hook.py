"""A question the agent blocks on is known from its ``PreToolUse`` hook.

Claude may keep a pending ``AskUserQuestion`` out of its transcript until it is
answered, so the transcript tail reads "mid-turn" — busy — and a chat surface
can neither switch off the PTY nor show the question. The hook records it on
the process; it reads as waiting-for-user until the transcript carries the
call's result (an answer, or Claude's own interrupted marker on resume).
"""

from __future__ import annotations

import json
from unittest.mock import PropertyMock, patch

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus

QUESTION = {"questions": [{"question": "Which VM?", "options": [{"label": "mac-vm"}, {"label": "diag-user2"}]}]}


@pytest.fixture
def no_side_effects(monkeypatch):
    async def save(entity):
        return entity

    async def emit(_self, _flow_data):
        return None

    monkeypatch.setattr(AgenticProcess, "save", save)
    monkeypatch.setattr(AgenticProcess, "emit_flow_data", emit)


def _hook(process_id: str, tool_name: str) -> AgentHookData:
    raw = {"hook_event_name": "PreToolUse", "tool_name": tool_name, "tool_use_id": "toolu_q", "tool_input": QUESTION}
    return AgentHookData(
        agentic_process_id=process_id, hook_data={"hook_event_name": "PreToolUse", "raw_hook_data": raw}
    )


def _transcript(path, *, answered: bool):
    lines = [{"type": "user", "message": {"content": "ask me which VM"}}]
    if answered:
        lines.append(
            {
                "type": "user",
                "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_q", "content": "mac-vm"}]},
            }
        )
    path.write_text("".join(json.dumps(line, separators=(",", ":")) + "\n" for line in lines))
    return path


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_side_effects")
async def test_question_hook_reads_as_waiting_for_user_until_answered(tmp_path):
    process = AgenticProcess(id=mint_uuid(), worker_type="claude_code", status="running", pty_mode=True)
    process.enable_pending_question_hook()
    assert "PreToolUse" in process.process_hook_events
    transcript = _transcript(tmp_path / "s.jsonl", answered=False)

    with (
        patch.object(AgenticProcess, "transcript_path", new_callable=PropertyMock, return_value=transcript),
        patch.object(AgenticProcess, "_discover_status_from_transcript", return_value=WorkerStatus.WORKING),
    ):
        await process.on_hook(_hook(str(process.id), "AskUserQuestion"))
        assert process.pending_user_input() == {
            "tool_use_id": "toolu_q",
            "tool_name": "AskUserQuestion",
            "input": QUESTION,
        }
        assert process.fetch_worker_status() is WorkerStatus.PENDING_USER

        _transcript(transcript, answered=True)  # answered in the terminal
        assert process.pending_user_input() is None
        assert process.fetch_worker_status() is WorkerStatus.WORKING


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_side_effects")
async def test_other_tools_are_not_questions(tmp_path):
    process = AgenticProcess(id=mint_uuid(), worker_type="claude_code", process_hook_events=["PreToolUse"])
    with patch.object(AgenticProcess, "transcript_path", new_callable=PropertyMock, return_value=None):
        await process.on_hook(_hook(str(process.id), "Bash"))
        assert process.pending_user_input() is None
