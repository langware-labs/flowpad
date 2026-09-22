"""DeepAgentsCLIStreamWorker — the real subprocess/pipe/converter path.

Uses the shared fake-CLI scaffolding so the genuine spawn seam is exercised without the
LangChain stack: a ``bash`` script prints the runner's event vocabulary.
"""

from __future__ import annotations

import json
import sys

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    WorkerSpawnError,
)
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.runner import MODULE as RUNNER_MODULE
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.status import deepagents_tail_status
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.stream_worker import (
    DeepAgentsCLIStreamWorker,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus
from tests.utils.fake_cli import fake_stream_argv, patch_build_spawn

SESSION = "0b8f6d2e-6c1f-4d0a-9d55-3f2f6c1a7e10"


def _event(type_: str, **fields) -> dict:
    return {"type": type_, "session_id": SESSION, "timestamp": "2026-09-18T12:00:00+00:00", **fields}


def _init() -> dict:
    return _event("init", model="z-ai/glm-5.3", cwd="/tmp", resumed=False, tools=[], subagents=[], skills=[], mcp_servers=[])


def _user(text: str = "hi") -> dict:
    return _event("user", text=text)


def _tool_call() -> dict:
    return _event("tool_call", tool_call_id="call_1", name="execute", input={"command": "git --version"}, message_id="m1", agent=None)


def _tool_result() -> dict:
    return _event("tool_result", tool_call_id="call_1", name="execute", output="git version 2.43.0", is_error=False, agent=None)


def _text(text: str = "git is installed", agent: str | None = None) -> dict:
    return _event("text", message_id="m2", text=text, agent=agent)


def _usage() -> dict:
    return _event("usage", message_id="m2", model="z-ai/glm-5.3", input_tokens=100, output_tokens=8, cache_read_tokens=0, reasoning_tokens=0)


def _result(is_error: bool = False) -> dict:
    return _event("result", subtype="error" if is_error else "success", is_error=is_error, num_turns=2, duration_ms=10, usage={})


async def _drain(worker: DeepAgentsCLIStreamWorker, prompt: str = "hi", **context_kwargs) -> list:
    context = AgenticContext(workdir=".", env_vars={}, session_id=SESSION, **context_kwargs)
    return [fd async for fd in worker.execute(prompt=prompt, context=context)]


def _types(frames: list) -> list[str]:
    return [str((fd.attributes or {}).get("element-type")) for fd in frames]


@pytest.mark.asyncio
async def test_a_full_turn_streams_every_element(monkeypatch, tmp_path):
    worker = DeepAgentsCLIStreamWorker(transcript_path=tmp_path / "tee.jsonl")
    patch_build_spawn(
        monkeypatch,
        DeepAgentsCLIStreamWorker,
        fake_stream_argv([_init(), _user(), _tool_call(), _tool_result(), _text(), _usage(), _result()]),
    )
    frames = await _drain(worker)

    types = _types(frames)
    for expected in (FlowElementType.USER_MESSAGE, FlowElementType.TOOL_CALL, FlowElementType.TOOL_RESULT, FlowElementType.CHAT, FlowElementType.RESULT):
        assert str(expected) in types, f"{expected} missing from {types}"
    assert worker.get_session_id() == SESSION


@pytest.mark.asyncio
async def test_stream_lines_are_teed_verbatim_and_the_tail_reads_complete(monkeypatch, tmp_path):
    """The runner prints the user's own turn and a terminal, so the tee is a complete transcript
    with nothing synthesized — and ``tail_status`` reaches COMPLETE off it."""
    tee = tmp_path / "deepagents_transcript.jsonl"
    worker = DeepAgentsCLIStreamWorker(transcript_path=tee)
    patch_build_spawn(monkeypatch, DeepAgentsCLIStreamWorker, fake_stream_argv([_init(), _user("do it"), _text(), _result()]))
    await _drain(worker, prompt="do it")

    lines = [json.loads(line) for line in tee.read_text(encoding="utf-8").splitlines()]
    assert [line["type"] for line in lines] == ["init", "user", "text", "result"]
    assert lines[1]["text"] == "do it"
    assert deepagents_tail_status(tee) == WorkerStatus.COMPLETE


@pytest.mark.asyncio
async def test_clean_exit_without_a_result_gets_a_synthetic_terminal(monkeypatch, tmp_path):
    """Termination is driven by EOF on stdout — no added wait — and the turn is still closed."""
    tee = tmp_path / "tee.jsonl"
    worker = DeepAgentsCLIStreamWorker(transcript_path=tee)
    patch_build_spawn(monkeypatch, DeepAgentsCLIStreamWorker, fake_stream_argv([_init(), _user(), _text()]))
    frames = await _drain(worker)

    last = json.loads(tee.read_text(encoding="utf-8").splitlines()[-1])
    assert last["type"] == "result" and last["reason"] == "synthetic-terminal"
    assert str(FlowElementType.RESULT) in _types(frames)
    assert deepagents_tail_status(tee) == WorkerStatus.COMPLETE


@pytest.mark.asyncio
async def test_an_error_result_reads_as_error(monkeypatch, tmp_path):
    tee = tmp_path / "tee.jsonl"
    worker = DeepAgentsCLIStreamWorker(transcript_path=tee)
    patch_build_spawn(
        monkeypatch,
        DeepAgentsCLIStreamWorker,
        fake_stream_argv([_init(), _user(), _event("error", message="AuthenticationError: 401", kind="auth"), _result(is_error=True)]),
    )
    frames = await _drain(worker)

    assert str(FlowElementType.ERROR) in _types(frames)
    assert deepagents_tail_status(tee) == WorkerStatus.ERROR


@pytest.mark.asyncio
async def test_a_subagents_text_never_ends_the_turn(monkeypatch, tmp_path):
    """Only the MAIN agent's text is the answer: a subagent's block is followed by more work."""
    worker = DeepAgentsCLIStreamWorker(transcript_path=tmp_path / "tee.jsonl")
    patch_build_spawn(
        monkeypatch,
        DeepAgentsCLIStreamWorker,
        fake_stream_argv([_init(), _user(), _text("sub says", agent="subagent"), _text("main answer"), _result()]),
    )
    frames = await _drain(worker)

    chats = [fd.flow_value for fd in frames if (fd.attributes or {}).get("element-type") == FlowElementType.CHAT]
    assert any("sub says" in str(v) for v in chats) and any("main answer" in str(v) for v in chats)


@pytest.mark.asyncio
async def test_a_nonzero_exit_with_no_terminal_is_recorded_as_an_error(monkeypatch, tmp_path):
    tee = tmp_path / "tee.jsonl"
    worker = DeepAgentsCLIStreamWorker(transcript_path=tee)
    patch_build_spawn(monkeypatch, DeepAgentsCLIStreamWorker, ["bash", "-c", "echo boom >&2; exit 3"])
    await _drain(worker)

    last = json.loads(tee.read_text(encoding="utf-8").splitlines()[-1])
    assert last["type"] == "flowpad.error" and last["exitCode"] == 3 and "boom" in last["message"]
    assert deepagents_tail_status(tee) == WorkerStatus.ERROR


# ── the real spawn seam (no patch): argv, install gate, declared-unsupported ──


def _context(tmp_path, **kwargs) -> AgenticContext:
    return AgenticContext(workdir=str(tmp_path), env_vars={"FLOWPAD_DEEPAGENTS_API_KEY": "k"}, session_id=SESSION, model="lg", **kwargs)


def test_argv_is_this_interpreter_running_our_runner(tmp_path):
    """The harness is a package beside FlowPad, so argv[0] is ``sys.executable`` — never a name
    looked up on PATH — and the tier has already become a gateway slug."""
    worker = DeepAgentsCLIStreamWorker(transcript_path=tmp_path / "tee.jsonl")
    argv, env, stdin = worker._build_spawn(_context(tmp_path), "install git")

    assert argv[:3] == [sys.executable, "-m", RUNNER_MODULE]
    assert argv[argv.index("--session-id") + 1] == SESSION
    assert argv[argv.index("--model") + 1] == "z-ai/glm-5.3"
    assert argv[argv.index("--workdir") + 1] == str(tmp_path)
    assert argv[argv.index("--checkpoint-db") + 1].endswith(f"{SESSION}.sqlite")
    assert stdin == "install git", "the prompt rides stdin, never argv"
    assert "install git" not in argv
    assert env["FLOWPAD_DEEPAGENTS_API_KEY"] == "k"


def test_skills_mcp_and_agents_reach_the_runner(tmp_path):
    mount = tmp_path / "assets"
    (mount / ".claude" / "skills" / "probe").mkdir(parents=True)
    worker = DeepAgentsCLIStreamWorker(
        transcript_path=tmp_path / "tee.jsonl",
        agents_json={"reviewer": {"description": "reviews", "prompt": "REVIEW"}},
    )
    fragment = {"mcpServers": {"flow": {"command": "flow-sdk-mcp", "args": []}}}
    argv, _, _ = worker._build_spawn(_context(tmp_path, add_dirs=[str(mount)], mcp_config_fragment=fragment), "hi")

    assert argv[argv.index("--skills-dir") + 1] == str(mount / ".claude" / "skills")
    assert json.loads(argv[argv.index("--mcp-config") + 1]) == fragment
    assert json.loads(argv[argv.index("--agents-json") + 1])["reviewer"]["prompt"] == "REVIEW"


def test_an_unsupported_permission_mode_fails_the_spawn_loudly(tmp_path):
    """Declared, not pretended: the shell tool sits outside the harness's permission model."""
    worker = DeepAgentsCLIStreamWorker(transcript_path=tmp_path / "tee.jsonl")
    with pytest.raises(WorkerSpawnError, match="permission mode"):
        worker._build_spawn(_context(tmp_path, permission_mode="plan"), "hi")


def test_a_missing_harness_package_fails_the_spawn(tmp_path, monkeypatch):
    """The install gate for a ``python -m`` harness is its distributions, not PATH."""
    from flow_sdk.core.capabilities import discovery
    from flow_sdk.core.capabilities.registry import PythonModuleCapabilityRunner

    monkeypatch.delitem(discovery._VALUES, "harness.deepagents.cli", raising=False)
    monkeypatch.setattr(PythonModuleCapabilityRunner, "missing_distributions", lambda self: ["deepagents"])
    worker = DeepAgentsCLIStreamWorker(transcript_path=tmp_path / "tee.jsonl")
    with pytest.raises(WorkerSpawnError):
        worker._build_spawn(_context(tmp_path), "hi")
