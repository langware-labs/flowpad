"""``intro`` / ``auto_launch`` / ``auto_launch_prompt`` are agent.json fields
that round-trip through ``AgentSpec`` and NEVER enters the launch bundle."""
from __future__ import annotations

import json

from flow_sdk.builtin.agent import Agent
from tests.unit.agent._parse import agent_default_body, parse_agent_document

AGENT_JSON = json.dumps({
    "type": "agent",
    "name": "greeter",
    "title": "Greeter",
    "intro": "Hi! Ask me anything about this project.\n",
    "auto_launch": True,
    "auto_launch_prompt": "Say hello and list the repo layout.",
    "enabled": True,
})
SYSTEM_PROMPT_MD = "You greet people.\n"


def test_frontmatter_round_trips_the_three_fields():
    fields = parse_agent_document(AGENT_JSON, "greeter", SYSTEM_PROMPT_MD)
    assert fields["intro"].strip() == "Hi! Ask me anything about this project."
    assert fields["auto_launch"] is True
    assert fields["auto_launch_prompt"] == "Say hello and list the repo layout."
    assert fields["system_prompt"] == "You greet people."

    entity = Agent(name="greeter", **{k: v for k, v in fields.items() if k != "name"})
    rendered = agent_default_body(entity)
    doc = json.loads(rendered)
    assert "intro" in doc
    assert doc["auto_launch"] is True
    assert doc["auto_launch_prompt"] == "Say hello and list the repo layout."
    again = parse_agent_document(rendered, "greeter")
    assert again["auto_launch"] is True
    assert again["intro"].strip() == fields["intro"].strip()


def test_defaults_are_off_and_empty():
    agent = Agent(name="plain")
    assert agent.intro == ""
    assert agent.auto_launch is False
    assert agent.auto_launch_prompt == ""


def test_new_fields_never_touch_the_launch_bundle():
    """The bundle is md5'd into ``last_started_hash``; a new key there would
    flip ``restart_required`` on every running process."""
    plain = Agent(name="x", model="haiku").to_agent_options().to_json()
    decorated = Agent(
        name="x", model="haiku", intro="Welcome", auto_launch=True, auto_launch_prompt="go"
    ).to_agent_options().to_json()
    assert plain == decorated
