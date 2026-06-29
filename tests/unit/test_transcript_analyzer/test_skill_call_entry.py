"""SkillCallEntry: each worker's parser normalizes its own skill shape onto the
one ``EntryKind.SKILL_CALL`` entry. Pure parsing — no live workers."""

from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.transcript_analyzer import (
    AgentTranscriptFile,
    EntryKind,
    SkillCallEntry,
    SkillInvocationKind,
)


def _write(tmp_path: Path, name: str, lines: list[dict]) -> Path:
    path = tmp_path / name
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8")
    return path


def test_claude_skill_tool_becomes_skill_call(tmp_path):
    path = _write(tmp_path, "claude.jsonl", [
        {
            "type": "assistant",
            "uuid": "a1",
            "sessionId": "s1",
            "timestamp": "2026-06-12T10:00:00Z",
            "message": {
                "id": "m1",
                "model": "claude",
                "content": [
                    {"type": "tool_use", "id": "tu1", "name": "Skill",
                     "input": {"skill": "my-skill"}},
                ],
            },
        },
    ])
    t = AgentTranscriptFile("claude", path)
    calls = list(t.filter(kind=EntryKind.SKILL_CALL))
    assert len(calls) == 1
    assert isinstance(calls[0], SkillCallEntry)
    assert calls[0].skill_name == "my-skill"
    assert calls[0].invocation_kind is SkillInvocationKind.TOOL


def test_copilot_skill_tool_becomes_skill_call(tmp_path):
    path = _write(tmp_path, "copilot.jsonl", [
        {"type": "session.created", "data": {"sessionId": "c1"},
         "id": "e0", "timestamp": "2026-06-12T10:00:00Z"},
        {
            "type": "assistant.message",
            "id": "e1",
            "timestamp": "2026-06-12T10:00:01Z",
            "data": {
                "sessionId": "c1",
                "toolRequests": [
                    {"toolCallId": "t1", "name": "skill",
                     "arguments": {"skill": "my-skill"}},
                ],
            },
        },
    ])
    t = AgentTranscriptFile("copilot", path)
    calls = list(t.filter(kind=EntryKind.SKILL_CALL))
    assert len(calls) == 1
    assert calls[0].skill_name == "my-skill"
    assert calls[0].invocation_kind is SkillInvocationKind.TOOL


def test_codex_skill_md_read_becomes_skill_call(tmp_path):
    # Codex has no skill tool: it loads a skill by reading its SKILL.md.
    path = _write(tmp_path, "codex.jsonl", [
        {"type": "thread.started", "thread_id": "x1", "timestamp": "2026-06-12T10:00:00Z"},
        {"type": "turn.started"},
        {"type": "item.completed", "item": {
            "id": "i1", "type": "command_execution",
            "command": "/bin/zsh -lc \"sed -n '1,200p' /home/u/.codex/skills/my-skill/SKILL.md\"",
            "aggregated_output": "---\nname: my-skill\n---\n", "exit_code": 0,
        }},
    ])
    t = AgentTranscriptFile("codex", path)
    calls = list(t.filter(kind=EntryKind.SKILL_CALL))
    assert len(calls) == 1
    assert calls[0].skill_name == "my-skill"
    assert calls[0].invocation_kind is SkillInvocationKind.FILE_LOAD
    # The underlying shell command is preserved alongside the skill entry.
    shells = list(t.filter(kind=EntryKind.SHELL_COMMAND)) + [
        e for e in t.filter(kind=EntryKind.TOOL_USE) if getattr(e, "tool_name", "") == "shell"
    ]
    assert shells, "codex shell command should still be present next to the skill entry"


def test_codex_ordinary_shell_is_not_a_skill_call(tmp_path):
    path = _write(tmp_path, "codex2.jsonl", [
        {"type": "thread.started", "thread_id": "x2", "timestamp": "2026-06-12T10:00:00Z"},
        {"type": "item.completed", "item": {
            "id": "i1", "type": "command_execution",
            "command": "/bin/zsh -lc 'ls -la /tmp'",
            "aggregated_output": "", "exit_code": 0,
        }},
    ])
    t = AgentTranscriptFile("codex", path)
    assert list(t.filter(kind=EntryKind.SKILL_CALL)) == []
