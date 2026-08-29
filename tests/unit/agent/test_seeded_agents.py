"""The shipped internal agents must parse, and must be cheap.

Every flowpad-internal launch runs through one of these, so a malformed
frontmatter or a missing model would show up as a mysterious expensive launch
rather than a parse error. Pin both here, where it is a fast unit test.
"""
from pathlib import Path

import pytest

from flow_sdk.config import flowpad_assistant_project_root
from tests.unit.agent._parse import parse_agent_markdown

AGENT_ROOT = Path(flowpad_assistant_project_root()) / "agentic-assets" / "agent"

EXPECTED = {
    "artifact-setup", "asset-cleanup", "capability-installer", "chrome-auth",
    "cloud-error-fixer", "diagnose", "email-summarizer", "emailer", "git-setup",
    "migration-runner", "task-analyze", "vibe",
}


def _agent_files():
    return sorted(AGENT_ROOT.glob("*/agent.md"))


#: Agents that have EARNED a bigger model, with the reason. Adding a row here
#: is a cost decision and should read like one.
COSTLIER_BY_DESIGN = {
    # Sending mail is irreversible, and haiku could not reliably call the
    # connector: an observed run searched for `create_draft` six times, printed
    # the JSON body it meant to send as prose, and delivered nothing. Sonnet
    # completed the same send first try. Tool-calling reliability is worth more
    # than the token saving when the action cannot be undone.
    "emailer": "sonnet",
}


def test_every_internal_launch_has_a_shipped_agent():
    assert {p.parent.name for p in _agent_files()} == EXPECTED


@pytest.mark.parametrize("path", _agent_files(), ids=lambda p: p.parent.name)
def test_shipped_agent_parses_and_is_cheap(path: Path):
    parsed = parse_agent_markdown(path.read_text(encoding="utf-8"), path.parent.name)
    assert parsed["name"] == path.parent.name
    assert parsed.get("description"), "an agent with no description is unreadable in project home"
    assert parsed["system_prompt"], "an agent with no system prompt has no identity"
    # sm tier == haiku (model_tiers.py). Internal agents must not silently
    # default to an expensive model — the exemptions below are deliberate and
    # each one names the failure that bought it.
    expected = COSTLIER_BY_DESIGN.get(path.parent.name, "haiku")
    assert parsed.get("model") == expected, (
        f"{path.parent.name} is on {parsed.get('model')}, expected {expected}"
    )
    assert parsed.get("worker_type") == "claude"
