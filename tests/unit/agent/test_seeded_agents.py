"""The shipped internal agents must parse, and must be cheap.

Every flowpad-internal launch runs through one of these, so a malformed
frontmatter or a missing model would show up as a mysterious expensive launch
rather than a parse error. Pin both here, where it is a fast unit test.
"""
from pathlib import Path

import pytest

from flow_sdk.config import flowpad_assistant_project_root
from flow_sdk.fs_store.indexer.functions.agent import parse_agent_markdown

AGENT_ROOT = Path(flowpad_assistant_project_root()) / "agentic-assets" / "agent"

EXPECTED = {
    "artifact-setup", "asset-cleanup", "capability-installer", "chrome-auth",
    "cloud-error-fixer", "diagnose", "email-summarizer", "emailer", "git-setup",
    "migration-runner", "task-analyze", "vibe",
}


def _agent_files():
    return sorted(AGENT_ROOT.glob("*/agent.md"))


def test_every_internal_launch_has_a_shipped_agent():
    assert {p.parent.name for p in _agent_files()} == EXPECTED


@pytest.mark.parametrize("path", _agent_files(), ids=lambda p: p.parent.name)
def test_shipped_agent_parses_and_is_cheap(path: Path):
    parsed = parse_agent_markdown(path.read_text(encoding="utf-8"), path.parent.name)
    assert parsed["name"] == path.parent.name
    assert parsed.get("description"), "an agent with no description is unreadable in project home"
    assert parsed["system_prompt"], "an agent with no system prompt has no identity"
    # sm tier == haiku (model_tiers.py). Internal agents must not silently
    # default to an expensive model.
    assert parsed.get("model") == "haiku", f"{path.parent.name} is not on haiku"
    assert parsed.get("worker_type") == "claude"
