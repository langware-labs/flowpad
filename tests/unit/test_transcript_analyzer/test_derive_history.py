"""Derivation on the HISTORY path — full load and incremental delta.

``AgentTranscriptFile._refold`` is the single history seam, and it runs again
on every ``parse_delta()``. Both must produce the derived entry, for every
worker, or a reloaded chat would disagree with the live one.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.transcript_analyzer import AgentTranscriptFile
from flow_sdk.transcript_analyzer.entries import FlowCommandEntry
from flow_sdk.transcript_analyzer.entry import EntryKind

_TYPE_ID = "skill-3f2a1b4c-0000-4000-8000-000000000001"
_COMMAND = f"flow show entity {_TYPE_ID}"


def _claude_lines() -> list[dict]:
    return [
        {
            "uuid": "u1", "sessionId": "s1", "type": "user",
            "timestamp": "2026-07-23T10:00:00Z",
            "message": {"role": "user", "content": "show it"},
        },
        {
            "uuid": "a1", "sessionId": "s1", "type": "assistant", "parentUuid": "u1",
            "timestamp": "2026-07-23T10:00:01Z",
            "message": {
                "id": "msg_1", "role": "assistant", "model": "claude-opus-4-8",
                "content": [{
                    "type": "tool_use", "id": "toolu_1", "name": "Bash",
                    "input": {"command": _COMMAND},
                }],
            },
        },
    ]


def _codex_lines() -> list[dict]:
    return [
        {
            "type": "item.completed",
            "item": {
                "id": "item_1", "type": "command_execution",
                "command": _COMMAND, "aggregated_output": "ok\n", "exit_code": 0,
            },
            "timestamp": "2026-07-23T10:00:01.000Z",
        },
    ]


def _copilot_lines() -> list[dict]:
    return [
        {
            "type": "assistant.message",
            "data": {
                "messageId": "m1", "model": "claude-haiku-4.5", "content": "",
                "toolRequests": [{
                    "toolCallId": "toolu_1", "name": "bash", "type": "function",
                    "arguments": {"command": _COMMAND},
                }],
            },
        },
    ]


WORKERS = pytest.mark.parametrize(
    ("worker", "lines"),
    [("claude", _claude_lines), ("codex", _codex_lines), ("copilot", _copilot_lines)],
    ids=["claude", "codex", "copilot"],
)


def _write(path, dicts) -> None:
    path.write_text("".join(json.dumps(d) + "\n" for d in dicts), encoding="utf-8")


def _flow_entries(transcript) -> list[FlowCommandEntry]:
    return list(transcript.filter(kind=EntryKind.FLOW_COMMAND))


@WORKERS
def test_full_load_derives_the_flow_command(tmp_path, worker, lines):
    path = tmp_path / f"{worker}.jsonl"
    _write(path, lines())

    transcript = AgentTranscriptFile(worker, path)

    [flow] = _flow_entries(transcript)
    assert isinstance(flow, FlowCommandEntry)
    assert (flow.verb, flow.subverb, flow.target) == ("show", "entity", _TYPE_ID)
    assert flow.worker == worker


@WORKERS
def test_delta_append_derives_too(tmp_path, worker, lines):
    """The refold behind ``parse_delta`` must derive, not just the first load."""
    path = tmp_path / f"{worker}.jsonl"
    _write(path, [])
    transcript = AgentTranscriptFile(worker, path)
    assert _flow_entries(transcript) == []

    _write(path, lines())
    transcript.parse_delta()

    [flow] = _flow_entries(transcript)
    assert flow.verb == "show"


@WORKERS
def test_repeated_refold_does_not_compound(tmp_path, worker, lines):
    path = tmp_path / f"{worker}.jsonl"
    _write(path, lines())
    transcript = AgentTranscriptFile(worker, path)

    before = len(transcript.entries)
    transcript.force_reparse()
    transcript.parse_delta()

    assert len(transcript.entries) == before
    assert len(_flow_entries(transcript)) == 1


def test_ordinary_shell_command_is_not_derived(tmp_path):
    path = tmp_path / "claude.jsonl"
    plain = _claude_lines()
    plain[1]["message"]["content"][0]["input"]["command"] = "ls -la"
    _write(path, plain)

    transcript = AgentTranscriptFile("claude", path)

    assert _flow_entries(transcript) == []
    assert list(transcript.filter(kind=EntryKind.SHELL_COMMAND))


def test_claude_flow_command_keeps_the_folded_result(tmp_path):
    """Derivation runs AFTER tool-result folding, so exit_code survives."""
    path = tmp_path / "claude.jsonl"
    lines = _claude_lines()
    lines.append({
        "uuid": "u2", "sessionId": "s1", "type": "user", "parentUuid": "a1",
        "timestamp": "2026-07-23T10:00:02Z",
        "message": {"role": "user", "content": [{
            "type": "tool_result", "tool_use_id": "toolu_1", "content": "displayed",
        }]},
        "toolUseResult": {"exitCode": 0, "stdout": "displayed"},
    })
    _write(path, lines)

    [flow] = _flow_entries(AgentTranscriptFile("claude", path))

    assert flow.exit_code == 0
    assert flow.stdout_preview == "displayed"
