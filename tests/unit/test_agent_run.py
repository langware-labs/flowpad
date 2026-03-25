"""End-to-end tests for AgentRecord + ClaudeProjectEnvManager + ClaudeCLIWorker pipeline.

Zero mocks — tests exercise the real build_args / build_env / setup logic.
Also covers ClaudeCodeAgenticWorker (SDK worker) import/instantiation paths.
"""

import asyncio
import json
from pathlib import Path
from typing import AsyncIterator
from unittest import mock

import pytest

from flow_sdk.builtin.agentic_workers import ClaudeCLIWorker
from flow_sdk.builtin.agentic_workers.agentic_worker import AgenticWorker
from flow_sdk.builtin.agentic_workers.context import AgenticContext
from flow_sdk.builtin.agentic_workers.session_history import (
    _extract_text_content,
    _load_jsonl,
    load_session_history,
)
from flow_sdk.claude_env import ClaudeProjectEnvManager
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData, FlowDataType, FlowElementType
from flow_sdk.fs_records.agent_record import AgentRecord
from flow_sdk.fs_records.skill_record import SkillRecord
from flow_sdk.fs_store import RecordType

FIXTURE_AGENT = (
    Path(__file__).resolve().parent.parent
    / "fixtures"
    / "agents"
    / "skill-creator"
    / "skill-creator.md"
)


# ---------------------------------------------------------------------------
# AgentRecord.from_file()
# ---------------------------------------------------------------------------


def test_from_file_loads_agent():
    """AgentRecord.from_file() reads .md and creates AgentRecord."""
    agent = AgentRecord.from_file(FIXTURE_AGENT)
    assert agent.name == "skill-creator"
    assert agent.data["model"] == "sonnet"
    assert agent.data["description"] == "Creates a skill record in the output directory."
    assert "Skill Creator Agent" in agent.prompt


# ---------------------------------------------------------------------------
# ClaudeProjectEnvManager
# ---------------------------------------------------------------------------


def test_env_creates_project_layout(tmp_path):
    env = ClaudeProjectEnvManager(root=tmp_path / "project")
    assert env.path.is_dir()
    assert env.agents_dir.is_dir()
    assert env.output_dir.is_dir()
    env.set_system_prompt("You are helpful.")
    assert env.claude_md_path.read_text() == "You are helpful."
    env.cleanup()
    assert not env.path.exists()


def test_env_append_system_prompt(tmp_path):
    env = ClaudeProjectEnvManager(root=tmp_path / "project")
    env.set_system_prompt("Line 1.")
    env.append_system_prompt("\nLine 2.")
    assert env.claude_md_path.read_text() == "Line 1.\nLine 2."


def test_env_load_agent_from_record(tmp_path):
    env = ClaudeProjectEnvManager(root=tmp_path / "project")
    agent = AgentRecord.from_file(FIXTURE_AGENT)
    env.load_agent(agent)
    md_file = env.agents_dir / "skill-creator.md"
    assert md_file.exists()
    assert "Skill Creator" in md_file.read_text()


def test_env_load_agent_from_path(tmp_path):
    env = ClaudeProjectEnvManager(root=tmp_path / "project")
    env.load_agent(FIXTURE_AGENT)
    md_file = env.agents_dir / "skill-creator.md"
    assert md_file.exists()
    assert "Skill Creator" in md_file.read_text()


def test_env_set_mcp_config(tmp_path):
    env = ClaudeProjectEnvManager(root=tmp_path / "project")
    env.set_mcp_config({"servers": {"test": {"command": "echo"}}})
    mcp_path = env.path / "mcp.json"
    assert mcp_path.exists()
    data = json.loads(mcp_path.read_text())
    assert "servers" in data


def test_env_vars(tmp_path):
    env = ClaudeProjectEnvManager(root=tmp_path / "project")
    env.env_set("MY_VAR", "hello")
    built = env.build_env()
    assert built["MY_VAR"] == "hello"
    env.env_unset("MY_VAR")
    built = env.build_env()
    assert "MY_VAR" not in built


def test_env_clean_wipes_existing(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / "stale.txt").write_text("old")
    env = ClaudeProjectEnvManager(root=root, clean=True)
    assert not (root / "stale.txt").exists()
    assert env.agents_dir.is_dir()


def test_env_temp_dir_when_no_root():
    env = ClaudeProjectEnvManager(root=None)
    try:
        assert env.path.is_dir()
        assert env.agents_dir.is_dir()
    finally:
        env.cleanup()


# ---------------------------------------------------------------------------
# ClaudeCLIWorker.build_args / build_env
# ---------------------------------------------------------------------------


def test_worker_build_args_basic():
    """build_args produces correct CLI with --dangerously-skip-permissions."""
    ctx = AgenticContext(workdir="/tmp/work", permission_mode="bypassPermissions")
    args = ClaudeCLIWorker.build_args("/usr/bin/claude", "Do stuff", "sess-1", ctx)

    assert args[0] == "/usr/bin/claude"
    assert "--dangerously-skip-permissions" in args
    assert "--session-id" in args
    assert args[args.index("--session-id") + 1] == "sess-1"
    assert "-p" in args
    assert args[args.index("-p") + 1] == "Do stuff"


def test_worker_build_args_with_model():
    """build_args includes --model when context specifies one."""
    ctx = AgenticContext(workdir="/tmp", model="sonnet")
    args = ClaudeCLIWorker.build_args("claude", "hi", "s1", ctx)
    assert "--model" in args
    assert args[args.index("--model") + 1] == "sonnet"


def test_worker_build_args_without_model():
    """build_args omits --model when not specified."""
    ctx = AgenticContext(workdir="/tmp")
    args = ClaudeCLIWorker.build_args("claude", "hi", "s1", ctx)
    assert "--model" not in args


def test_worker_build_args_with_agents_json():
    """build_args includes --agents with serialized JSON."""
    ctx = AgenticContext(workdir="/tmp")
    agents = {"my-agent": {"description": "Test", "prompt": "Do it"}}
    args = ClaudeCLIWorker.build_args("claude", "go", "s1", ctx, agents_json=agents)
    assert "--agents" in args
    parsed = json.loads(args[args.index("--agents") + 1])
    assert "my-agent" in parsed
    assert parsed["my-agent"]["description"] == "Test"


def test_worker_build_args_askuser_permission():
    """build_args omits --dangerously-skip-permissions for non-bypass modes."""
    ctx = AgenticContext(workdir="/tmp", permission_mode="askUser")
    args = ClaudeCLIWorker.build_args("claude", "hi", "s1", ctx)
    assert "--dangerously-skip-permissions" not in args


def test_worker_build_env_sets_project_dir(tmp_path):
    """build_env sets CLAUDE_PROJECT_DIR from context.workdir."""
    ctx = AgenticContext(workdir=str(tmp_path))
    env = ClaudeCLIWorker.build_env(ctx)
    assert env["CLAUDE_PROJECT_DIR"] == str(tmp_path)


def test_worker_build_env_strips_claudecode(tmp_path, monkeypatch):
    """build_env strips CLAUDECODE* variables from os.environ."""
    monkeypatch.setenv("CLAUDECODE_SESSION", "should-be-gone")
    monkeypatch.setenv("NORMAL_VAR", "keep-me")
    ctx = AgenticContext(workdir=str(tmp_path))
    env = ClaudeCLIWorker.build_env(ctx)
    assert "CLAUDECODE_SESSION" not in env
    assert env["NORMAL_VAR"] == "keep-me"


def test_worker_build_env_includes_context_vars(tmp_path):
    """build_env overlays context.env_vars."""
    ctx = AgenticContext(workdir=str(tmp_path), env_vars={"MY_KEY": "my_val"})
    env = ClaudeCLIWorker.build_env(ctx)
    assert env["MY_KEY"] == "my_val"


# ---------------------------------------------------------------------------
# Full pipeline: AgentRecord → AgenticContext → ClaudeCLIWorker.build_args
# ---------------------------------------------------------------------------


def test_pipeline_agent_to_worker_args(tmp_path):
    """Full pipeline: from_file → env setup → worker builds correct CLI args."""
    agent = AgentRecord.from_file(FIXTURE_AGENT)
    env = ClaudeProjectEnvManager(root=tmp_path / "project")
    env.load_agent(agent)
    env.append_system_prompt(f"\n\n## Output\nWrite to: {env.output_dir}\n")

    # Build context from agent data (same as AgentExecution.prepare does)
    ctx = AgenticContext(
        workdir=str(env.path),
        model=agent.data.get("model"),
        permission_mode=agent.data.get("permission_mode", "bypassPermissions"),
    )
    agents_json = agent.to_agents_json()
    worker = ClaudeCLIWorker()
    args = worker.build_args("claude", "Create a skill", "sess-42", ctx, agents_json=agents_json)

    # Verify full CLI shape
    assert args[0] == "claude"
    assert "--dangerously-skip-permissions" in args
    assert "--model" in args
    assert args[args.index("--model") + 1] == "sonnet"
    assert "--agents" in args
    parsed_agents = json.loads(args[args.index("--agents") + 1])
    assert "skill-creator" in parsed_agents
    assert parsed_agents["skill-creator"]["description"] == "Creates a skill record in the output directory."
    assert "-p" in args
    assert args[args.index("-p") + 1] == "Create a skill"

    # Verify env
    worker_env = worker.build_env(ctx)
    assert worker_env["CLAUDE_PROJECT_DIR"] == str(env.path)

    # Verify CLAUDE.md was written with output dir
    claude_md = env.claude_md_path.read_text()
    assert str(env.output_dir) in claude_md

    # Verify agent md is in .claude/agents/
    assert (env.agents_dir / "skill-creator.md").exists()


def test_pipeline_agent_domain_context(tmp_path):
    """Agent.run() produces compatible context via Agent DomainObject."""
    from flow_sdk.domain.agent import Agent
    from flow_sdk.domain.environment import Environment

    agent_record = AgentRecord.from_file(FIXTURE_AGENT)
    agent_do = Agent.fromRecord(agent_record)
    env = Environment.load(str(tmp_path))

    # Verify the Agent DomainObject provides the same data
    agents_json = agent_record.to_agents_json()
    assert "skill-creator" in agents_json
    assert agent_do.prompt == agent_record.prompt
    assert agent_do.model == "sonnet"

    # Build AgenticContext from Agent properties (what Agent.run() will do)
    ctx = AgenticContext(
        workdir=env.work_dir,
        model=agent_do.model,
        permission_mode=agent_record.data.get("permission_mode", "bypassPermissions"),
    )
    args = ClaudeCLIWorker.build_args("claude", "Run it", "s1", ctx, agents_json=agents_json)
    assert "--agents" in args
    assert "--dangerously-skip-permissions" in args


# ---------------------------------------------------------------------------
# Skill output validation (no mocks needed — just filesystem)
# ---------------------------------------------------------------------------


def test_agent_output_skill_loadable(tmp_path):
    """Simulated agent output is loadable by SkillRecord."""
    env = ClaudeProjectEnvManager(root=tmp_path / "project")
    skill_dir = env.output_dir / "greeting-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: greeting-skill\ndescription: A friendly greeting skill\ntags:\n  - greeting\n---\n\nGreet the user warmly."
    )
    skill = SkillRecord.load_record(skill_dir)
    assert skill is not None
    assert skill.name == "greeting-skill"


def test_agent_domain_run_creates_process(tmp_path):
    """Agent.run() creates an AgenticProcess via process_runner."""
    from flow_sdk.domain.agent import Agent
    from flow_sdk.domain.agentic_process import AgenticProcess
    from flow_sdk.domain.environment import Environment
    from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord

    agent_record = AgentRecord.from_file(FIXTURE_AGENT)
    agent_do = Agent.fromRecord(agent_record)
    env = Environment.load(str(tmp_path))

    mock_record = AgenticProcessRecord(id="test-proc", name="test")
    mock_proc = mock.MagicMock()

    with mock.patch(
        "flow_sdk.builtin.process_runner.run_process",
        return_value=(mock_record, mock_proc),
    ) as mock_rp:
        result = agent_do.run("Create a test skill", env)

    assert isinstance(result, AgenticProcess)
    assert result.id == "test-proc"
    mock_rp.assert_called_once()


# ---------------------------------------------------------------------------
# AgenticContext
# ---------------------------------------------------------------------------


def test_context_defaults():
    """AgenticContext has sensible defaults."""
    ctx = AgenticContext()
    assert ctx.permission_mode == "bypassPermissions"
    assert ctx.max_thinking_tokens == 1024
    assert ctx.amd_support is False
    assert ctx.workdir is not None  # defaults to cwd


def test_context_with_values():
    """AgenticContext accepts all fields."""
    ctx = AgenticContext(
        workdir="/tmp/test",
        model="sonnet",
        permission_mode="askUser",
        env_vars={"FOO": "bar"},
        amd_support=True,
        resume_session_id="abc-123",
        fork_session=True,
    )
    assert ctx.workdir == "/tmp/test"
    assert ctx.model == "sonnet"
    assert ctx.env_vars == {"FOO": "bar"}
    assert ctx.amd_support is True
    assert ctx.resume_session_id == "abc-123"
    assert ctx.fork_session is True


def test_context_to_persistable_dict():
    """to_persistable_dict() excludes compute_node and stack_frame."""
    ctx = AgenticContext(
        workdir="/tmp",
        model="opus",
        stack_frame={"x": 1},
    )
    d = ctx.to_persistable_dict()
    assert "compute_node" not in d
    assert "stack_frame" not in d
    assert d["workdir"] == "/tmp"
    assert d["model"] == "opus"


# ---------------------------------------------------------------------------
# AgenticWorker ABC
# ---------------------------------------------------------------------------


class _StubWorker(AgenticWorker):
    """Minimal concrete worker for testing the ABC interface."""

    def __init__(self):
        self.executed_prompts: list[str] = []

    async def execute(self, prompt: str, context: AgenticContext) -> AsyncIterator[FlowData]:
        self.executed_prompts.append(prompt)
        yield FlowData(
            flow_value=f"Echo: {prompt}",
            attributes={
                "element-type": FlowElementType.CHAT,
                "data-type": FlowDataType.TEXT,
            },
        )


@pytest.mark.asyncio
async def test_worker_abc_execute():
    """Concrete worker executes and yields FlowData."""
    worker = _StubWorker()
    ctx = AgenticContext(workdir="/tmp")
    chunks = []
    async for chunk in worker.execute("hello", ctx):
        chunks.append(chunk)
    assert len(chunks) == 1
    assert chunks[0].flow_value == "Echo: hello"
    assert worker.executed_prompts == ["hello"]


def test_worker_abc_defaults():
    """Default ABC methods are no-ops / return None/False."""
    worker = _StubWorker()
    assert worker.get_session_id() is None
    assert worker.get_history() is None
    assert worker.manages_history() is False
    # These should not raise
    worker.pause()
    worker.resume()
    worker.set_history([])


@pytest.mark.asyncio
async def test_worker_abc_async_defaults():
    """Default async methods are no-ops."""
    worker = _StubWorker()
    await worker.inject("test")
    await worker.close_session()


# ---------------------------------------------------------------------------
# ClaudeCodeAgenticWorker (SDK worker)
# ---------------------------------------------------------------------------


def test_sdk_worker_import_without_sdk():
    """ClaudeCodeAgenticWorker class can be imported even without claude_agent_sdk."""
    from flow_sdk.builtin.agentic_workers.claude_code_agentic_worker import ClaudeCodeAgenticWorker

    assert ClaudeCodeAgenticWorker is not None


def test_sdk_worker_instantiation_fails_without_sdk():
    """Instantiating ClaudeCodeAgenticWorker raises ImportError without claude_agent_sdk."""
    from flow_sdk.builtin.agentic_workers.claude_code_agentic_worker import (
        ClaudeCodeAgenticWorker,
        _SDK_AVAILABLE,
    )

    if _SDK_AVAILABLE:
        pytest.skip("claude_agent_sdk is installed, cannot test missing SDK path")

    with pytest.raises(ImportError, match="claude_agent_sdk is required"):
        ClaudeCodeAgenticWorker()


def test_sdk_worker_init_export_graceful():
    """Package __init__ exports ClaudeCodeAgenticWorker (or None if SDK missing)."""
    from flow_sdk.builtin.agentic_workers import ClaudeCodeAgenticWorker

    # Should be either the class or None, never raise
    assert ClaudeCodeAgenticWorker is None or callable(ClaudeCodeAgenticWorker)


# ---------------------------------------------------------------------------
# ClaudeCodeAgenticWorker with mocked SDK
# ---------------------------------------------------------------------------


def _make_mock_sdk_worker():
    """Create a ClaudeCodeAgenticWorker with mocked SDK internals."""
    from flow_sdk.builtin.agentic_workers import claude_code_agentic_worker as mod

    # Temporarily enable SDK
    original = mod._SDK_AVAILABLE
    mod._SDK_AVAILABLE = True
    try:
        # Patch __init__ to skip the SDK check
        worker = object.__new__(mod.ClaudeCodeAgenticWorker)
        worker._client = None
        worker._input_queue = None
        worker._paused = None
        worker._session_active = False
        worker._session_id = None
        worker._history = []
        worker._block_group_ids = {}
        worker._context_cache = None
        worker._pending_outputs = []
        return worker
    finally:
        mod._SDK_AVAILABLE = original


def test_sdk_worker_pause_resume():
    """pause() clears event, resume() sets it."""
    worker = _make_mock_sdk_worker()
    worker._paused = asyncio.Event()
    worker._paused.set()

    assert worker._paused.is_set()
    worker.pause()
    assert not worker._paused.is_set()
    worker.resume()
    assert worker._paused.is_set()


@pytest.mark.asyncio
async def test_sdk_worker_inject():
    """inject() puts message on queue."""
    worker = _make_mock_sdk_worker()
    worker._input_queue = asyncio.Queue()

    await worker.inject("test message")
    assert worker._input_queue.qsize() == 1
    msg = worker._input_queue.get_nowait()
    assert msg == "test message"


@pytest.mark.asyncio
async def test_sdk_worker_inject_multiple():
    """Multiple injects maintain order."""
    worker = _make_mock_sdk_worker()
    worker._input_queue = asyncio.Queue()

    await worker.inject("first")
    await worker.inject("second")
    await worker.inject("third")

    assert worker._input_queue.get_nowait() == "first"
    assert worker._input_queue.get_nowait() == "second"
    assert worker._input_queue.get_nowait() == "third"


def test_sdk_worker_history():
    """History management interface works."""
    worker = _make_mock_sdk_worker()
    assert worker.manages_history() is True
    assert worker.get_history() == []
    assert worker.get_session_id() is None

    test_data = [
        FlowData(flow_value="test", attributes={"element-type": FlowElementType.CHAT})
    ]
    worker.set_history(test_data)
    assert worker.get_history() == test_data

    worker._session_id = "test-session-123"
    assert worker.get_session_id() == "test-session-123"


def test_sdk_worker_has_active_session():
    """has_active_session() reflects client state."""
    worker = _make_mock_sdk_worker()
    assert worker.has_active_session() is False
    worker._client = mock.MagicMock()
    assert worker.has_active_session() is True


@pytest.mark.asyncio
async def test_sdk_worker_close_session():
    """close_session() cleans up state."""
    worker = _make_mock_sdk_worker()
    worker._input_queue = asyncio.Queue()
    worker._paused = asyncio.Event()
    worker._session_active = True
    worker._context_cache = AgenticContext()
    worker._client = mock.AsyncMock()
    worker._client.__aexit__ = mock.AsyncMock()

    await worker.close_session()

    assert worker._session_active is False
    assert worker._input_queue is None
    assert worker._paused is None
    assert worker._context_cache is None
    assert worker._client is None


def test_sdk_worker_should_save_to_history_complete():
    """Complete blocks are saved to history."""
    worker = _make_mock_sdk_worker()
    fd = FlowData(
        flow_value="test",
        attributes={"element-type": FlowElementType.CHAT, "complete": "true"},
    )
    assert worker._should_save_to_history(fd) is True


def test_sdk_worker_should_save_to_history_streaming_delta():
    """Streaming deltas (no complete flag) are not saved."""
    worker = _make_mock_sdk_worker()
    fd = FlowData(
        flow_value="delta",
        attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
    )
    assert worker._should_save_to_history(fd) is False


def test_sdk_worker_should_save_to_history_tool_call():
    """Tool calls are always saved (non-streamable type)."""
    worker = _make_mock_sdk_worker()
    fd = FlowData(
        flow_value={"tool_name": "Read"},
        attributes={"element-type": FlowElementType.TOOL_CALL, "data-type": FlowDataType.OBJECT},
    )
    assert worker._should_save_to_history(fd) is True


def test_sdk_worker_should_save_to_history_error():
    """Errors are always saved."""
    worker = _make_mock_sdk_worker()
    fd = FlowData(
        flow_value="Something failed",
        attributes={"element-type": FlowElementType.ERROR, "data-type": FlowDataType.TEXT},
    )
    assert worker._should_save_to_history(fd) is True


# ---------------------------------------------------------------------------
# Session history utilities
# ---------------------------------------------------------------------------


def test_extract_text_content_string():
    assert _extract_text_content("hello") == "hello"


def test_extract_text_content_list():
    content = [
        {"type": "text", "text": "first"},
        {"type": "text", "text": "second"},
    ]
    assert _extract_text_content(content) == "first\nsecond"


def test_extract_text_content_empty():
    assert _extract_text_content([]) == ""
    assert _extract_text_content(42) == ""


def test_load_jsonl(tmp_path):
    """_load_jsonl reads JSONL file."""
    f = tmp_path / "test.jsonl"
    f.write_text('{"type":"user","message":{"content":"hi"}}\n{"type":"assistant","message":{"content":[]}}\n')
    entries = _load_jsonl(f)
    assert len(entries) == 2
    assert entries[0]["type"] == "user"


def test_load_jsonl_limit(tmp_path):
    """_load_jsonl respects limit."""
    f = tmp_path / "test.jsonl"
    f.write_text('{"a":1}\n{"a":2}\n{"a":3}\n')
    entries = _load_jsonl(f, limit=2)
    assert len(entries) == 2


def test_load_jsonl_missing():
    """_load_jsonl returns empty for missing file."""
    entries = _load_jsonl(Path("/nonexistent/file.jsonl"))
    assert entries == []


def test_load_session_history_with_data(tmp_path):
    """load_session_history converts JSONL entries to FlowData."""
    session_id = "test-session-abc"
    projects_dir = tmp_path / ".claude" / "projects" / "proj1"
    projects_dir.mkdir(parents=True)
    jsonl = projects_dir / f"{session_id}.jsonl"
    jsonl.write_text(
        json.dumps({"type": "user", "message": {"content": "Hello"}}) + "\n"
        + json.dumps({
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "Hi there"}]}
        }) + "\n"
    )

    with mock.patch("flow_sdk.builtin.agentic_workers.session_history.get_session_jsonl_path", return_value=jsonl):
        history = load_session_history(session_id)

    assert len(history) == 2
    assert history[0].attributes["role"] == "user"
    assert history[1].attributes["role"] == "assistant"
    assert "Hi there" in history[1].flow_value
