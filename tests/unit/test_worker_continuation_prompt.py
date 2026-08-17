"""Deterministic transcript handoff prompt and read-action failure."""

from __future__ import annotations

import json

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.responses.response import ApiFailResponse
from flow_sdk.transcript_analyzer import (
    TranscriptFormat,
    worker_continuation_prompt,
)


def test_worker_continuation_prompt_renders_exact_real_claude_jsonl(tmp_path):
    path = tmp_path / "session.jsonl"
    rows = [
        {
            "type": "user",
            "uuid": "user-1",
            "sessionId": "session-1",
            "message": {"content": "Original question"},
        },
        {
            "type": "assistant",
            "uuid": "assistant-1",
            "sessionId": "session-1",
            "message": {
                "content": [{"type": "text", "text": "Original answer"}],
            },
        },
    ]
    path.write_text(
        "\n".join(json.dumps(row) for row in rows) + "\n",
        encoding="utf-8",
    )

    assert worker_continuation_prompt(
        path,
        "claude",
        "Claude",
        transcript_format=TranscriptFormat.CLAUDE_JSONL,
    ) == (
        "We are continuing the conversation from Claude:\n\n"
        "    ==== user_message user-1 ====\n"
        "    worker: claude\n"
        "    session_id: session-1\n"
        "    --\n"
        "    text: Original question\n"
        "\n"
        "    ==== assistant_message assistant-1 ====\n"
        "    worker: claude\n"
        "    session_id: session-1\n"
        "    --\n"
        "    text: Original answer"
    )


@pytest.mark.asyncio
async def test_continuation_prompt_action_fails_without_descriptor():
    process = AgenticProcess(id=mint_uuid(), worker_type="claude_code")

    response = await process.continuation_prompt_action()

    assert isinstance(response, ApiFailResponse)
    assert response.status_code == 404
    assert response.message == "No readable transcript available for continuation"
