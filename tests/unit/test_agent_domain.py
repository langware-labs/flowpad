"""Tests for AgentRunner class."""

from pathlib import Path
from unittest import mock

import pytest

from flow_sdk.fs_records.agent_record import AgentRecord


FIXTURE_AGENT = (
    Path(__file__).resolve().parent.parent
    / "fixtures"
    / "agents"
    / "skill-creator"
    / "skill-creator.md"
)


def test_load_existing_agent(tmp_path):
    """AgentRunner.load(name) returns an AgentRunner when the agent dir exists."""
    from flow_sdk.builtin.agent_runner import AgentRunner

    # Create a minimal agent directory structure
    agent_dir = tmp_path / ".claude" / "agents" / "test-agent"
    agent_dir.mkdir(parents=True)
    (agent_dir / "test-agent.md").write_text(
        "---\nname: test-agent\ndescription: A test agent\n---\n\nYou are a test agent."
    )

    agent = AgentRunner.load("test-agent", project_dir=tmp_path)
    assert agent is not None
    assert agent.name == "test-agent"
    assert "test agent" in agent.prompt.lower()


def test_load_missing_raises():
    """AgentRunner.load('nonexistent') raises FileNotFoundError."""
    from flow_sdk.builtin.agent_runner import AgentRunner

    with pytest.raises(FileNotFoundError, match="nonexistent"):
        AgentRunner.load("nonexistent", project_dir="/tmp/empty-nonexistent-dir")


def test_fromRecord():
    """AgentRunner.fromRecord(agent_record) returns AgentRunner with matching name, prompt."""
    from flow_sdk.builtin.agent_runner import AgentRunner

    record = AgentRecord.from_file(FIXTURE_AGENT)
    agent = AgentRunner.fromRecord(record)
    assert agent.name == record.name
    assert agent.prompt == record.prompt


def test_run_creates_process(tmp_path):
    """agent.run(instruction, workdir) with mocked run_process returns AgenticProcess."""
    from flow_sdk.builtin.agent_runner import AgentRunner
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord

    record = AgentRecord.from_file(FIXTURE_AGENT)
    agent = AgentRunner.fromRecord(record)

    mock_record = AgenticProcessRecord(id="proc-1", name="test-proc")
    mock_proc = mock.MagicMock()

    with mock.patch(
        "flow_sdk.builtin.process_runner.run_process",
        return_value=(mock_record, mock_proc),
    ):
        result = agent.run("Create something", workdir=str(tmp_path))

    assert isinstance(result, AgenticProcess)
    assert result.id == "proc-1"


def test_run_copies_agent_md(tmp_path):
    """agent.run(instruction, workdir) copies .md file to workdir/.claude/agents/."""
    from flow_sdk.builtin.agent_runner import AgentRunner
    from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord

    # Create agent from fixture (has a real record_dir with .md file)
    fixture_dir = FIXTURE_AGENT.parent
    record = AgentRecord.load_from_dir(fixture_dir)
    assert record is not None
    agent = AgentRunner.fromRecord(record)

    mock_record = AgenticProcessRecord(id="proc-2", name="test")
    mock_proc = mock.MagicMock()

    with mock.patch(
        "flow_sdk.builtin.process_runner.run_process",
        return_value=(mock_record, mock_proc),
    ):
        agent.run("Do something", workdir=str(tmp_path))

    # Check that the .md was copied
    agents_dir = tmp_path / ".claude" / "agents"
    assert agents_dir.is_dir()
    copied_files = list(agents_dir.glob("*.md"))
    assert len(copied_files) >= 1
