"""Routing integrity for the agent-builder skill.

Modelled on `test_connect_data_source_skill_routing.py`: every row of the index
points at a file that exists, every file is reachable from a row, and the ground
rules inlined into each mode and topic file cannot drift apart silently.

The skill-specific tests pin what the skill TEACHES to the code it describes: the
literal `agent.json` must validate as an `AgentSpec`, and every field its table
names must be a real `AgentSpec` field — a renamed field fails here instead of
teaching users a key the loader ignores.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from flow_sdk.assets.types.skill import parse_skill_yaml_from_dir
from flow_sdk.schema.data_spec.agent_spec import AgentSpec

SKILLS = Path(__file__).resolve().parents[2] / "flow_sdk/system_projects/flowpad_assistant/.claude/skills"
SKILL_DIR = SKILLS / "agent-builder"
INDEX = SKILL_DIR / "SKILL.md"
IGNORED_DIRS = {".flow", "__pycache__"}
GROUND_RULES_HEADER = "Ground rules (inline by design"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _routed_paths(text: str) -> set[str]:
    return set(re.findall(r"(?:modes|topics|references)/[A-Za-z0-9_.-]+\.md", text))


def _authored_files() -> list[Path]:
    return [
        p
        for p in SKILL_DIR.rglob("*")
        if p.is_file()
        and p != INDEX
        and not any(part in IGNORED_DIRS for part in p.relative_to(SKILL_DIR).parts)
    ]


def _ground_rules(text: str) -> str:
    """The quoted block that starts with the ground-rules header."""
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if GROUND_RULES_HEADER in line)
    block = []
    for line in lines[start:]:
        if not line.startswith(">"):
            break
        block.append(line)
    return "\n".join(block)


def _json_blocks(text: str) -> list[dict]:
    return [json.loads(block) for block in re.findall(r"```json\n(.*?)```", text, re.S)]


def test_the_skill_is_installed_where_it_ships_from():
    assert INDEX.is_file(), f"no SKILL.md at {SKILL_DIR}"


def test_every_routing_row_resolves():
    for ref in sorted(_routed_paths(_read(INDEX))):
        assert (SKILL_DIR / ref).is_file(), f"SKILL.md routes to {ref}, which does not exist"


def test_no_unreachable_files():
    routed = _routed_paths(_read(INDEX))
    for path in _authored_files():
        rel = str(path.relative_to(SKILL_DIR))
        assert rel in routed, f"{rel} is in the skill but no routing row mentions it"


def test_every_mode_and_topic_inlines_the_same_ground_rules():
    canonical = _ground_rules(_read(INDEX))
    for folder in ("modes", "topics"):
        for path in sorted((SKILL_DIR / folder).glob("*.md")):
            assert _ground_rules(_read(path)) == canonical, f"{folder}/{path.name}: ground rules drifted from SKILL.md"


def test_the_skill_never_reaches_for_the_navigating_verb():
    forbidden = "flow " + "navigate"
    for path in [INDEX, *_authored_files()]:
        assert forbidden not in _read(path), f"{path.name} names the navigating verb — defer to flowpad-navigation"


def test_every_topic_and_the_screens_table_show_something():
    for path in [*sorted((SKILL_DIR / "topics").glob("*.md")), SKILL_DIR / "references/screens.md"]:
        assert "flow show" in _read(path), f"{path.name} never opens a screen for the user"


def test_the_description_carries_the_triggering_burden():
    fm = parse_skill_yaml_from_dir(SKILL_DIR)  # read the way the app loads it
    description = fm["description"]

    assert fm["name"] == "agent-builder"
    assert len(description) > 200
    for phrase in ("agent that", "tutor", "watches this page", "code can call", "deploy", "improve"):
        assert phrase in description, f"the description never mentions {phrase!r}"
    # Bounded against its neighbours: subagents and record CRUD belong elsewhere.
    assert "NOT for" in description
    assert ".claude/agents/" in description and "flowpad-assistance" in description


def test_the_neighbours_hand_agents_over():
    # The route is only real if the skills that used to own "create an agent" say
    # so too; otherwise a later edit to one of them silently takes it back.
    for neighbour in ("building-deliverables", "flowpad-assistance"):
        description = parse_skill_yaml_from_dir(SKILLS / neighbour)["description"]
        assert "agent-builder" in description, f"{neighbour} no longer routes agents to agent-builder"


def test_the_literal_agent_json_blocks_are_valid_agent_specs():
    blocks = _json_blocks(_read(SKILL_DIR / "references/agent-json.md"))
    assert len(blocks) >= 3, "agent-json.md lost its minimal, shapes or places example"
    for block in blocks:
        AgentSpec.model_validate(block)


def test_the_field_table_names_only_real_fields():
    text = _read(SKILL_DIR / "references/agent-json.md")
    table_fields = set(re.findall(r"^\| `([a-z_]+)` \|", text, re.M))
    assert table_fields, "agent-json.md lost its field table"
    unknown = table_fields - set(AgentSpec.model_fields)
    assert not unknown, f"agent-json.md documents fields AgentSpec does not have: {sorted(unknown)}"


def test_declared_fields_really_never_reach_a_launch():
    """Ground rule 3 tells the model a *declared* field enforces nothing. Pin the
    table's *declared* rows to the launch itself, so the day one of them starts
    being applied this fails and the table (and the rule) get updated with it."""
    from flow_sdk.builtin.agent import Agent

    text = _read(SKILL_DIR / "references/agent-json.md")
    declared = set(re.findall(r"^\| `([a-z_]+)` \|[^|]*\| declared \|", text, re.M))
    assert {"max_turns", "tools", "disallowed_tools", "skills"} <= declared, declared

    sentinels = {"max_turns": 7771, "tools": ["SentinelToolA"], "disallowed_tools": ["SentinelToolB"]}
    agent = Agent(name="declared-probe", model="md", **sentinels)
    launched = json.dumps(agent.to_agent_options(worker_type="claude").to_json(), default=str)
    for field, value in sentinels.items():
        assert json.dumps(value).strip("[]") not in launched, f"{field} now reaches the launch — mark it enforced"


def test_the_validation_loop_keeps_its_script_template():
    text = _read(SKILL_DIR / "references/validation-loop.md")
    for heading in ("## Test script", "## What to send me back"):
        assert heading in text, f"validation-loop.md lost {heading!r}"


def test_the_index_stays_an_index():
    assert len(_read(INDEX).splitlines()) < 300
