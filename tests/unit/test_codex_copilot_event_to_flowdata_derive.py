"""Codex / Copilot live converters derive the same entries history does.

Both drivers wrap parsed entries in ``_wrap_live``; derivation is applied
there so a `flow` CLI call streams as a ``flow_command`` frame, exactly like
the one a reload replays out of the JSONL.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.codex import (
    convert_event as codex_convert_event,
)
from flow_sdk.builtin.agentic_process.cli_drivers.copilot import (
    convert_event as copilot_convert_event,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from flow_sdk.transcript_analyzer import AgentTranscriptFile

_TYPE_ID = "skill-3f2a1b4c-0000-4000-8000-000000000001"
_COMMAND = f"flow show entity {_TYPE_ID}"


def _codex_event(command: str) -> dict:
    return {
        "type": "item.completed",
        "item": {
            "id": "item_1", "type": "command_execution",
            "command": command, "aggregated_output": "ok\n", "exit_code": 0,
        },
        "timestamp": "2026-07-23T10:00:01.000Z",
    }


def _copilot_event(command: str) -> dict:
    return {
        "type": "assistant.message",
        "data": {
            "messageId": "m1", "model": "claude-haiku-4.5", "content": "",
            "toolRequests": [{
                "toolCallId": "toolu_1", "name": "bash", "type": "function",
                "arguments": {"command": command},
            }],
        },
    }


WORKERS = pytest.mark.parametrize(
    ("worker", "convert", "event"),
    [
        ("codex", codex_convert_event, _codex_event),
        ("copilot", copilot_convert_event, _copilot_event),
    ],
    ids=["codex", "copilot"],
)


def _flow_frames(frames):
    return [fd for fd in frames if fd.attributes.get("subtype") == "flow_command"]


@WORKERS
def test_live_flow_command_frame(worker, convert, event):
    frames = convert(event(_COMMAND))

    [fd] = _flow_frames(frames)
    assert fd.attributes["element-type"] == FlowElementType.TOOL_CALL
    assert fd.attributes["flow-verb"] == "show"
    assert fd.attributes["flow-target"] == _TYPE_ID
    assert fd.attributes["observation-kind"] == "live"


@WORKERS
def test_ordinary_shell_is_not_derived_live(worker, convert, event):
    assert _flow_frames(convert(event("ls -la"))) == []


@WORKERS
def test_live_matches_history_for_the_same_event(tmp_path, worker, convert, event):
    """Same event, both paths — the semantic payload must be identical.

    Only the envelope differs (the live driver stamps ``subtype`` /
    ``observation-kind`` on top); every field a chip reads has to agree.
    """
    live = _flow_frames(convert(event(_COMMAND)))[0]

    path = tmp_path / f"{worker}.jsonl"
    path.write_text(json.dumps(event(_COMMAND)) + "\n", encoding="utf-8")
    transcript = AgentTranscriptFile(worker, path)
    [replay] = [
        fd
        for entry in transcript.entries
        for fd in entry.to_flow_data()
        if "flow-verb" in fd.attributes
    ]

    envelope = {"subtype", "observation-kind"}
    assert {k: v for k, v in live.attributes.items() if k not in envelope} == replay.attributes
    assert live.flow_value == replay.flow_value
