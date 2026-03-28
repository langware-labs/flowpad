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


