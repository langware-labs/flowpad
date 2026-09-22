"""The Deep Agents transcript parser + tail classifier, over the runner's own event vocabulary."""

from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.session_history import load_transcript_history
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.status import deepagents_tail_status
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from flow_sdk.transcript_analyzer import TranscriptFormat
from flow_sdk.transcript_analyzer.entries import (
    AgentSpawnEntry,
    AssistantMessageEntry,
    FileEditEntry,
    FileReadEntry,
    FileWriteEntry,
    SearchEntry,
    ShellCommandEntry,
    ToolResultEntry,
    ToolUseEntry,
    UsageEntry,
    UserMessageEntry,
)
from flow_sdk.transcript_analyzer.parsers import get_parser_class
from flow_sdk.transcript_analyzer.parsers.deepagents import DeepAgentsParser, DeepAgentsStreamParser
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus

SESSION = "0b8f6d2e-6c1f-4d0a-9d55-3f2f6c1a7e10"


def _event(type_: str, **fields) -> dict:
    return {"type": type_, "session_id": SESSION, "timestamp": "2026-09-18T12:00:00+00:00", **fields}


def _feed(*events: dict) -> list:
    parser = DeepAgentsParser()
    return [entry for index, event in enumerate(events) for entry in parser.feed(event, index)]


def test_the_parser_is_registered_by_worker_and_by_format():
    assert get_parser_class("deepagents") is DeepAgentsParser
    assert get_parser_class("anything", TranscriptFormat.DEEPAGENTS_STREAM) is DeepAgentsStreamParser


def test_session_model_and_messages():
    entries = _feed(
        _event("init", model="z-ai/glm-5.3", cwd="/w", resumed=False),
        _event("user", text="install git"),
        _event("reasoning", message_id="m1", text="need apt", agent=None),
        _event("text", message_id="m1", text="done", agent=None),
    )
    user, reasoning, text = entries[1], entries[2], entries[3]
    assert isinstance(user, UserMessageEntry) and user.text == "install git"
    assert isinstance(reasoning, AssistantMessageEntry) and reasoning.thinking == "need apt" and reasoning.text == ""
    assert isinstance(text, AssistantMessageEntry) and text.text == "done"
    # The model rides ``init`` — every later entry is stamped with it, so pricing never guesses.
    assert text.model == "z-ai/glm-5.3" and all(e.session_id == SESSION for e in entries)


@pytest.mark.parametrize(
    ("name", "tool_input", "entry_type"),
    [
        ("execute", {"command": "git --version"}, ShellCommandEntry),
        ("read_file", {"file_path": "/w/a.py"}, FileReadEntry),
        ("write_file", {"file_path": "/w/a.py", "content": "x"}, FileWriteEntry),
        ("edit_file", {"file_path": "/w/a.py"}, FileEditEntry),
        ("grep", {"pattern": "TODO"}, SearchEntry),
        ("glob", {"pattern": "**/*.py"}, SearchEntry),
        ("ls", {"path": "/w"}, SearchEntry),
        ("task", {"subagent_type": "reviewer", "description": "review it"}, AgentSpawnEntry),
        ("write_todos", {"todos": []}, ToolUseEntry),
        ("some_mcp_tool", {"q": 1}, ToolUseEntry),
    ],
)
def test_builtin_tools_map_to_the_shared_semantic_entries(name, tool_input, entry_type):
    (entry,) = _feed(_event("tool_call", tool_call_id="c1", name=name, input=tool_input, message_id="m", agent=None))
    assert type(entry) is entry_type
    assert entry.tool_use_id == "c1" and entry.tool_name == name


def test_a_tool_result_pairs_with_its_call_by_id():
    (entry,) = _feed(_event("tool_result", tool_call_id="c1", name="execute", output="ok", is_error=True, agent=None))
    assert isinstance(entry, ToolResultEntry)
    assert entry.tool_use_id == "c1" and entry.tool_output == "ok" and entry.is_error is True


def test_usage_folds_per_dimension_with_a_stable_key():
    entries = _feed(
        _event("usage", message_id="m9", model="z-ai/glm-5.3", input_tokens=100, output_tokens=8, cache_read_tokens=64, reasoning_tokens=0)
    )
    assert all(isinstance(e, UsageEntry) for e in entries)
    assert {e.io: e.count for e in entries} == {"input": 100, "output": 8, "cache_read": 64}  # zero dims are dropped
    assert {e.entry_id for e in entries} == {"m9:usage:input", "m9:usage:output", "m9:usage:cache_read"}
    assert all(e.model == "z-ai/glm-5.3" for e in entries)


@pytest.mark.parametrize(
    ("events", "expected"),
    [
        ([_event("init")], WorkerStatus.INITIALIZING),
        ([_event("init"), _event("user", text="x")], WorkerStatus.WORKING),
        ([_event("user", text="x"), _event("tool_call", name="execute")], WorkerStatus.TOOL_CALL),
        ([_event("tool_call", name="execute"), _event("tool_result")], WorkerStatus.THINKING),
        ([_event("text", text="x"), _event("result", is_error=False)], WorkerStatus.COMPLETE),
        ([_event("error", message="401"), _event("result", is_error=True)], WorkerStatus.ERROR),
        ([_event("text", text="x"), {"type": "flowpad.interrupted", "session_id": SESSION}], WorkerStatus.INTERRUPTED),
        ([_event("text", text="x"), {"type": "flowpad.error", "session_id": SESSION, "message": "boom"}], WorkerStatus.ERROR),
    ],
)
def test_tail_status(tmp_path, events, expected):
    path = tmp_path / "deepagents_transcript.jsonl"
    path.write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
    assert deepagents_tail_status(path) == expected


def test_history_replays_the_transcript_through_the_same_mapping(tmp_path):
    """Replay goes through the SHARED transcript layer, so this vendor inherits its one-row-per-
    operation rule: a shell/file result folds into its call, a catch-all (MCP) tool keeps a
    separate result row. Pairing is by ``tool_call_id`` — which is why the runner must carry it."""
    path = tmp_path / "deepagents_transcript.jsonl"
    events = [
        _event("init", model="z-ai/glm-5.3"),
        _event("user", text="hi"),
        _event("tool_call", tool_call_id="c1", name="execute", input={"command": "ls"}, message_id="m", agent=None),
        _event("tool_result", tool_call_id="c1", name="execute", output="a.txt", is_error=False, agent=None),
        _event("tool_call", tool_call_id="c2", name="some_mcp_tool", input={"q": 1}, message_id="m", agent=None),
        _event("tool_result", tool_call_id="c2", name="some_mcp_tool", output="42", is_error=False, agent=None),
        _event("text", message_id="m2", text="listed", agent=None),
        _event("result", is_error=False),
    ]
    path.write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")

    frames = load_transcript_history(path)
    kinds = [str((fd.attributes or {}).get("element-type")) for fd in frames]
    assert kinds.count(str(FlowElementType.USER_MESSAGE)) == 1
    assert kinds.count(str(FlowElementType.CHAT)) == 1
    assert kinds.count(str(FlowElementType.TOOL_CALL)) == 2
    assert kinds.count(str(FlowElementType.TOOL_RESULT)) == 1, "only the catch-all tool keeps its own result row"

    shell = next(fd for fd in frames if (fd.process_entry or {}).get("transcript_entry", {}).get("kind") == "shell_command")
    assert "a.txt" in json.dumps(shell.process_entry), "the shell result folded into its call"
