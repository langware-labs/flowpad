"""``intro`` / ``auto_launch`` / ``auto_launch_prompt`` are agent.md frontmatter
that round-trips through ``AgentSpec`` and NEVER enters the launch bundle."""
from __future__ import annotations

from flow_sdk.builtin.agent import Agent, AgentSpec
from tests.unit.agent._parse import agent_default_body, parse_agent_markdown

AGENT_MD = """---
name: greeter
title: Greeter
intro: |
  Hi! Ask me anything about this project.
auto_launch: true
auto_launch_prompt: Say hello and list the repo layout.
enabled: true
---

You greet people.
"""


def test_frontmatter_round_trips_the_three_fields():
    fields = parse_agent_markdown(AGENT_MD, "greeter")
    assert fields["intro"].strip() == "Hi! Ask me anything about this project."
    assert fields["auto_launch"] is True
    assert fields["auto_launch_prompt"] == "Say hello and list the repo layout."
    assert fields["system_prompt"] == "You greet people."

    entity = Agent(name="greeter", **{k: v for k, v in fields.items() if k != "name"})
    rendered = agent_default_body(entity)
    assert "intro:" in rendered
    assert "auto_launch: true" in rendered
    assert "auto_launch_prompt: Say hello and list the repo layout." in rendered
    again = parse_agent_markdown(rendered, "greeter")
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
