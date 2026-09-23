"""The Deep Agents runner, for real: the actual subprocess, deepagents' actual tool loop, its
actual shell backend and SQLite checkpointer — with only the MODEL scripted.

This is what proves the protocol the stream worker consumes is what the runner really prints.
A test that reaches the engine pays the LangChain import in a fresh process, so it is ``long``.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.runner import (
    MODULE,
    mcp_connections,
    subagents_from_agents_json,
)

pytest.importorskip("deepagents", reason="the deepagents harness needs Python >=3.11")

REPO = Path(__file__).resolve().parents[2]
FACTORY = "tests.utils.deepagents_fake_model:scripted"
SESSION = "5a0c0a3e-1b6e-4c7d-8a55-6f0e3c1b2d90"


def _run(tmp_path: Path, script: list[dict], prompt: str, *extra: str) -> tuple[list[dict], subprocess.CompletedProcess]:
    script_file = tmp_path / "script.json"
    script_file.write_text(json.dumps(script), encoding="utf-8")
    env = {**os.environ, "DEEPAGENTS_FAKE_SCRIPT": str(script_file), "PYTHONPATH": str(REPO), "FLOWPAD_DEEPAGENTS_API_KEY": "secret-token"}
    proc = subprocess.run(
        [sys.executable, "-m", MODULE, "--session-id", SESSION, "--workdir", str(tmp_path), "--model", "scripted",
         "--checkpoint-db", str(tmp_path / "sessions" / f"{SESSION}.sqlite"), "--model-factory", FACTORY, *extra],
        input=prompt, capture_output=True, text=True, check=False, env=env, cwd=str(REPO),
    )
    events = [json.loads(line) for line in proc.stdout.splitlines() if line.strip().startswith("{")]
    return events, proc


@pytest.mark.long  # 1.78s — pays the LangChain stack import in a real subprocess
def test_a_tool_turn_prints_the_whole_protocol(tmp_path):
    events, proc = _run(
        tmp_path,
        [
            {"tool_calls": [{"name": "execute", "args": {"command": "echo hello-from-shell"}}]},
            {"text": "The shell said hello."},
        ],
        "say hello from the shell",
    )
    assert proc.returncode == 0, proc.stderr[-2000:]

    types = [e["type"] for e in events]
    assert types[0] == "init" and types[1] == "user" and types[-1] == "result"
    assert all(e["session_id"] == SESSION and e["timestamp"] for e in events)
    assert events[1]["text"] == "say hello from the shell"

    call = next(e for e in events if e["type"] == "tool_call")
    result = next(e for e in events if e["type"] == "tool_result")
    assert call["name"] == "execute" and call["input"] == {"command": "echo hello-from-shell"} and call["agent"] is None
    assert result["tool_call_id"] == call["tool_call_id"] and "hello-from-shell" in result["output"] and result["is_error"] is False

    text = next(e for e in events if e["type"] == "text")
    assert text["text"] == "The shell said hello." and text["agent"] is None
    assert any(e["type"] == "usage" and e["input_tokens"] == 10 for e in events)
    assert events[-1]["is_error"] is False and events[-1]["subtype"] == "success" and events[-1]["num_turns"] == 2


@pytest.mark.long  # ~1.7s — a real subprocess
@pytest.mark.parametrize("finish_reason", ["error", "stop"])
def test_a_turn_cut_short_upstream_ends_as_an_error_not_a_success(tmp_path, finish_reason):
    """A provider failure delivered inside a 200 — an empty message, no tool calls — ends the graph
    normally. It used to print ``subtype=success``: a task cut off mid-way read as done. Judged on
    the shape, so an empty completion that says ``stop`` is caught too."""
    events, proc = _run(
        tmp_path,
        [
            {"tool_calls": [{"name": "execute", "args": {"command": "echo step-one"}}]},
            {"text": "", "finish_reason": finish_reason},
        ],
        "install it",
    )
    assert proc.returncode == 1, proc.stderr[-2000:]
    error = next(e for e in events if e["type"] == "error")
    assert error["kind"] == "incomplete" and repr(finish_reason) in error["message"]
    assert events[-1]["type"] == "result" and events[-1]["subtype"] == "error" and events[-1]["is_error"] is True


@pytest.mark.long  # 1.63s
def test_what_the_agent_executes_never_sees_the_funding_token(tmp_path):
    """The token is the MODEL's. The runner drops it from its own env before the shell backend
    inherits that env, so ``env`` run by the agent cannot print it."""
    events, proc = _run(
        tmp_path,
        [{"tool_calls": [{"name": "execute", "args": {"command": "env"}}]}, {"text": "done"}],
        "print the environment",
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    output = next(e for e in events if e["type"] == "tool_result")["output"]
    assert "secret-token" not in output


@pytest.mark.long  # 3.20s — two real runner processes
def test_a_second_process_resumes_the_same_session(tmp_path):
    """Cross-process resume off the per-session SQLite checkpoint: the second run's model sees the
    first run's messages (the scripted model would not care, so the proof is ``resumed`` plus the
    checkpoint file the first run left)."""
    first, proc1 = _run(tmp_path, [{"text": "noted: PINEAPPLE"}], "remember PINEAPPLE")
    assert proc1.returncode == 0, proc1.stderr[-2000:]
    assert first[0]["resumed"] is False
    assert (tmp_path / "sessions" / f"{SESSION}.sqlite").is_file()

    second, proc2 = _run(tmp_path, [{"text": "it was PINEAPPLE"}], "what was it?")
    assert proc2.returncode == 0, proc2.stderr[-2000:]
    assert second[0]["resumed"] is True
    assert second[-1]["type"] == "result" and second[-1]["is_error"] is False


def test_an_unsupported_permission_mode_is_an_error_then_a_result(tmp_path):
    """Refused before the engine is imported (so this is fast): the runner says why, then ends
    the turn like any other — ``error`` is non-terminal, ``result`` is the terminal."""
    proc = subprocess.run(
        [sys.executable, "-m", MODULE, "--session-id", SESSION, "--workdir", str(tmp_path), "--model", "x",
         "--checkpoint-db", str(tmp_path / "s.sqlite"), "--permission-mode", "plan"],
        input="hi", capture_output=True, text=True, check=False, env={**os.environ, "PYTHONPATH": str(REPO)}, cwd=str(REPO),
    )
    lines = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    assert proc.returncode == 1
    assert [line["type"] for line in lines] == ["error", "result"]
    assert "permission mode" in lines[0]["message"] and lines[1]["is_error"] is True


# ── pure helpers (fast) ───────────────────────────────────────────────────────


def test_version_answers_from_metadata_without_importing_the_engine():
    """The capability probe budget is 5s and the engine takes seconds to import."""
    proc = subprocess.run(
        [sys.executable, "-c", f"import sys, {MODULE} as r; r.main(['--version']); print('deepagents' in sys.modules)"],
        capture_output=True, text=True, check=False, env={**os.environ, "PYTHONPATH": str(REPO)}, cwd=str(REPO),
    )
    assert proc.returncode == 0, proc.stderr[-1500:]
    assert proc.stdout.splitlines()[0].startswith("deepagents ")
    assert proc.stdout.splitlines()[-1] == "False", "--version imported the engine"


def test_claude_agents_json_becomes_subagent_dicts():
    subagents = subagents_from_agents_json(
        {"reviewer": {"description": "reviews code", "prompt": "REVIEW", "tools": "Bash, Read", "model": "sonnet"}}
    )
    # tools/model name CLAUDE tools and aliases — meaningless here, so dropped on purpose.
    assert subagents == [{"name": "reviewer", "description": "reviews code", "system_prompt": "REVIEW"}]


def test_mcp_servers_body_becomes_adapter_connections():
    connections = mcp_connections(
        {"mcpServers": {
            "local": {"command": "flow-sdk-mcp", "args": ["--x"], "env": {"A": "1"}},
            "remote": {"type": "http", "url": "https://x.test/mcp", "headers": {"Authorization": "Bearer t"}},
            "legacy": {"type": "sse", "url": "https://x.test/sse"},
        }}
    )
    assert connections["local"] == {"transport": "stdio", "command": "flow-sdk-mcp", "args": ["--x"], "env": {"A": "1"}}
    assert connections["remote"] == {"transport": "streamable_http", "url": "https://x.test/mcp", "headers": {"Authorization": "Bearer t"}}
    assert connections["legacy"] == {"transport": "sse", "url": "https://x.test/sse"}
