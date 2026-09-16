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
    "migration-runner", "slack-poster", "slack-summarizer", "task-analyze", "vibe",
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
    # Posting into a channel is just as irreversible as sending mail, and it is
    # the same send-verb tool-calling pattern the emailer's incident documented.
    # Same reasoning, same tier.
    "slack-poster": "sonnet",
}


def test_every_internal_launch_has_a_shipped_agent():
    assert {p.parent.name for p in _agent_files()} == EXPECTED


@pytest.mark.parametrize("path", _agent_files(), ids=lambda p: p.parent.name)
def test_shipped_agent_parses_and_is_cheap(path: Path):
    parsed = parse_agent_markdown(path.read_text(encoding="utf-8"), path.parent.name)
    assert parsed["name"] == path.parent.name
    assert parsed.get("description"), "an agent with no description is unreadable in project home"
    assert parsed["system_prompt"], "an agent with no system prompt has no identity"
    # Internal agents must not silently default to an expensive model — the
    # exemptions above are deliberate and each one names the failure that bought
    # it.
    #
    # The cheap tier has TWO legal spellings and this assertion accepts both,
    # because they are the same model: `sm` is the portable tier (model_tiers.py)
    # and `haiku` names one vendor's family. Prefer `sm` in new agents — the
    # literal resolves to `claude-haiku-4-5-20251001`, which an OpenRouter or hub
    # LLMEndpoint does not serve, so `capability-installer` failed with "may not
    # exist or you may not have access" on exactly the bare machine it exists to
    # fix. The tier resolves per provider and works on both.
    CHEAP = {"sm", "haiku"}
    expected = COSTLIER_BY_DESIGN.get(path.parent.name)
    model = parsed.get("model")
    if expected is None:
        assert model in CHEAP, (
            f"{path.parent.name} is on {model}, expected the cheap tier "
            f"(one of {sorted(CHEAP)})"
        )
    else:
        assert model == expected, (
            f"{path.parent.name} is on {model}, expected {expected}"
        )
    assert parsed.get("worker_type") == "claude"
