"""Unit tests for AgentRecord."""

import json
import shutil
from pathlib import Path
from unittest import mock

import pytest

from flow_sdk.fs_records.agent_record import AgentRecord
from flow_sdk.fs_records._frontmatter import (
    _coerce_scalar,
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store import RecordType
from flow_sdk.fs_store.record import get_default_records_root, set_default_records_root


@pytest.fixture(autouse=True)
def isolated_records_root(tmp_path):
    """Redirect the default records root to a temp dir for every test."""
    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    yield tmp_path / "records"
    set_default_records_root(original)


# ---------------------------------------------------------------------------
# Frontmatter utilities
# ---------------------------------------------------------------------------


class TestFrontmatterUtils:
    def test_coerce_scalar_int(self):
        assert _coerce_scalar("42") == 42

    def test_coerce_scalar_float(self):
        assert _coerce_scalar("3.14") == 3.14

    def test_coerce_scalar_bool(self):
        assert _coerce_scalar("true") is True
        assert _coerce_scalar("false") is False

    def test_coerce_scalar_null(self):
        assert _coerce_scalar("null") is None
        assert _coerce_scalar("none") is None

    def test_coerce_scalar_quoted(self):
        assert _coerce_scalar('"hello"') == "hello"
        assert _coerce_scalar("'world'") == "world"

    def test_coerce_scalar_string(self):
        assert _coerce_scalar("hello") == "hello"

    def test_extract_frontmatter(self):
        text = "---\nname: test\ndescription: a test\n---\n\nBody here."
        fm = _extract_frontmatter(text)
        assert fm == "name: test\ndescription: a test"

    def test_extract_frontmatter_none(self):
        assert _extract_frontmatter("No frontmatter") is None

    def test_extract_body(self):
        text = "---\nname: test\n---\n\nBody here."
        body = _extract_body(text)
        assert body == "Body here."

    def test_extract_body_no_frontmatter(self):
        text = "Just a body."
        assert _extract_body(text) == "Just a body."

    def test_render_frontmatter(self):
        result = _render_frontmatter({"name": "test", "model": "sonnet"})
        assert result.startswith("---\n")
        assert result.endswith("\n---")
        assert "name" in result
        assert "model" in result

    def test_yaml_load(self):
        text = "name: test\nmax_turns: 30\nbackground: true"
        data = _yaml_load(text)
        assert data["name"] == "test"
        assert data["max_turns"] == 30
        assert data["background"] is True


# ---------------------------------------------------------------------------
# AgentRecord
# ---------------------------------------------------------------------------


class TestAgentRecord:
    def test_create_from_kwargs(self):
        agent = AgentRecord(
            id="test-agent",
            name="test-agent",
            description="A test agent",
            model="sonnet",
            max_turns=10,
            tools=["Read", "Write"],
        )
        assert agent.type == RecordType.AGENT
        assert agent.name == "test-agent"
        assert agent.description == "A test agent"
        assert agent.model == "sonnet"
        assert agent.max_turns == 10
        assert agent.tools == ["Read", "Write"]

    def test_to_agents_json(self):
        agent = AgentRecord(
            id="analyzer",
            name="analyzer",
            description="Analyze things",
            model="sonnet",
            max_turns=20,
            disallowed_tools=["Bash"],
            permission_mode="bypassPermissions",
        )
        agent.prompt_text = "You are an analyzer."

        result = agent.to_agents_json()
        assert "analyzer" in result
        entry = result["analyzer"]
        assert entry["description"] == "Analyze things"
        assert entry["model"] == "sonnet"
        assert entry["maxTurns"] == 20
        assert entry["disallowedTools"] == ["Bash"]
        assert entry["permissionMode"] == "bypassPermissions"
        assert entry["prompt"] == "You are an analyzer."

    def test_from_agents_json(self):
        data = {
            "description": "Test desc",
            "prompt": "Do things",
            "model": "opus",
            "maxTurns": 5,
            "disallowedTools": ["Edit"],
            "permissionMode": "askUser",
        }
        agent = AgentRecord.from_agents_json("my-agent", data)
        assert agent.name == "my-agent"
        assert agent.description == "Test desc"
        assert agent.model == "opus"
        assert agent.max_turns == 5
        assert agent.disallowed_tools == ["Edit"]
        assert agent.permission_mode == "askUser"

    def test_agents_json_roundtrip(self):
        original = AgentRecord(
            id="roundtrip",
            name="roundtrip",
            description="Round trip test",
            model="haiku",
            max_turns=15,
            tools=["Read"],
            background=True,
        )
        original.prompt_text = "System prompt here."

        json_out = original.to_agents_json()
        entry = json_out["roundtrip"]
        restored = AgentRecord.from_agents_json("roundtrip", entry)

        assert restored.description == "Round trip test"
        assert restored.model == "haiku"
        assert restored.max_turns == 15
        assert restored.tools == ["Read"]
        assert restored.background is True
        assert restored.prompt == "System prompt here."

    def test_to_markdown(self):
        agent = AgentRecord(
            id="md-test",
            name="md-test",
            description="Markdown test",
            model="sonnet",
        )
        agent.prompt_text = "You are a helpful agent."
        md = agent.to_markdown()
        assert "---" in md
        assert "description" in md
        assert "You are a helpful agent." in md

    def test_from_markdown(self):
        text = """---
name: from-md
description: From markdown test
model: opus
max_turns: 20
---

You are a specialized agent for testing.

## Instructions

Do the thing."""
        agent = AgentRecord.from_markdown(text)
        assert agent.name == "from-md"
        assert agent.description == "From markdown test"
        assert agent.model == "opus"
        assert agent.max_turns == 20
        assert "specialized agent" in agent.prompt

    def test_markdown_roundtrip(self):
        original = AgentRecord(
            id="md-rt",
            name="md-rt",
            description="Markdown roundtrip",
            model="sonnet",
            max_turns=10,
        )
        original.prompt_text = "Be helpful."
        md = original.to_markdown()
        restored = AgentRecord.from_markdown(md)
        assert restored.description == "Markdown roundtrip"
        assert restored.model == "sonnet"

    def test_init_record_from_dir(self, tmp_path):
        """Test bootstrapping AgentRecord from a .md file in a directory."""
        agent_dir = tmp_path / "agent-@test-boot"
        agent_dir.mkdir()
        md_content = """---
name: test-boot
description: Bootstrap test
model: haiku
---

Bootstrap prompt content."""
        (agent_dir / "test-boot.md").write_text(md_content)

        agent = AgentRecord.load_record(agent_dir)
        assert agent.name == "test-boot"
        assert agent.data.get("description") == "Bootstrap test"
        assert agent.data.get("model") == "haiku"
        assert "Bootstrap prompt content." in agent.prompt

    def test_save_writes_both_files(self, tmp_path, isolated_records_root):
        """Test that save() writes metadata.json to records_root shadow — not agent dir."""
        agent = AgentRecord(
            id="save-test",
            name="save-test",
            description="Save test",
            model="sonnet",
        )
        agent.prompt_text = "Save prompt."

        # Simulate an external agent dir (e.g. ~/.claude/agents/)
        agent_dir = tmp_path / "external_agents"
        agent_dir.mkdir()

        agent.save()

        # metadata.json must be in records_root shadow folder, NOT the external agent dir
        shadow_dir = isolated_records_root / "agent" / "agent-@save-test"
        assert (shadow_dir / "metadata.json").exists()
        assert not (agent_dir / "metadata.json").exists(), \
            "metadata.json must not be written to the external agent dir"

        # .md companion is written next to metadata.json (in records_root)
        md_file = shadow_dir / "save-test.md"
        assert md_file.exists()
        md_content = md_file.read_text()
        assert "Save prompt." in md_content

    def test_init_record_does_not_write_to_agent_dir(self, tmp_path, isolated_records_root):
        """init_record from an agent dir must NOT write metadata.json or state.json there."""
        agent_dir = tmp_path / "agent-@no-write"
        agent_dir.mkdir()
        (agent_dir / "no-write.md").write_text("---\nname: no-write\n---\nContent.\n")

        AgentRecord.load_record(agent_dir)

        assert not (agent_dir / "metadata.json").exists(), \
            "metadata.json must not be written to the agent source dir"
        assert not (agent_dir / "state.json").exists(), \
            "state.json must not be written to the agent source dir"

    def test_prompt_from_file(self, tmp_path):
        """Test the prompt property reads from companion .md file."""
        agent_dir = tmp_path / "agent-@prompt-test"
        agent_dir.mkdir()
        (agent_dir / "prompt-test.md").write_text(
            "---\ndescription: test\n---\n\nPrompt from file."
        )

        agent = AgentRecord(id="prompt-test", name="prompt-test")
        agent.path = str(agent_dir)
        agent.source_file = str(agent_dir / ".flow_record" / "record.json")

        assert agent.prompt == "Prompt from file."


# ---------------------------------------------------------------------------
# Agent loader
# ---------------------------------------------------------------------------


class TestAgentLoader:
    def test_load_from_dir(self, tmp_path):
        agent_dir = tmp_path / "my-agent"
        agent_dir.mkdir()
        (agent_dir / "my-agent.md").write_text(
            "---\nname: my-agent\ndescription: Loader test\n---\n\nLoader prompt."
        )
        agent = AgentRecord.load_from_dir(agent_dir)
        assert agent is not None
        assert agent.name == "my-agent"

    def test_load_from_dir_missing(self, tmp_path):
        assert AgentRecord.load_from_dir(tmp_path / "nonexistent") is None

    def test_load_agent_project_priority(self, tmp_path):
        """Project agents should be found before user/system."""
        project = tmp_path / "project"
        agent_dir = project / ".claude" / "agents" / "my-agent"
        agent_dir.mkdir(parents=True)
        (agent_dir / "my-agent.md").write_text(
            "---\nname: my-agent\ndescription: Project agent\n---\n\nProject prompt."
        )

        agent = AgentRecord.load_agent("my-agent", project_dir=project)
        assert agent is not None
        assert agent.data.get("description") == "Project agent"

    def test_load_system_agent_from_package(self):
        """Load the bundled session-analyzer agent from the SDK package."""
        agent = AgentRecord.load_system_agent("session-analyzer")
        assert agent is not None
        assert agent.name == "session-analyzer"
        assert agent.data.get("description") is not None
