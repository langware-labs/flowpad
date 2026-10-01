"""Routing integrity for the cred-scan skill.

Modelled on `test_connect_data_source_skill_routing.py`: every index row points
at a file that exists, every file is reachable from a row, the ground rules
inlined into each phase file cannot drift apart, and the description carries the
triggering burden.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

SKILL_DIR = (
    Path(__file__).resolve().parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/cred-scan"
)
INDEX = SKILL_DIR / "SKILL.md"
IGNORED_DIRS = {".flow", "__pycache__"}


def _routed_paths(text: str) -> set[str]:
    return set(re.findall(r"(?:phases|references|scripts)/[A-Za-z0-9_.-]+", text))


def _authored_files() -> list[Path]:
    return [
        p
        for p in SKILL_DIR.rglob("*")
        if p.is_file()
        and p != INDEX
        and not any(part in IGNORED_DIRS for part in p.relative_to(SKILL_DIR).parts)
    ]


def test_the_skill_is_installed_where_it_ships_from():
    assert INDEX.is_file(), f"no SKILL.md at {SKILL_DIR}"


def test_every_routing_row_resolves():
    for ref in sorted(_routed_paths(INDEX.read_text(encoding="utf-8"))):
        assert (SKILL_DIR / ref).is_file(), f"SKILL.md routes to {ref}, which does not exist"


def test_no_unreachable_files():
    routed = _routed_paths(INDEX.read_text(encoding="utf-8"))
    for path in _authored_files():
        rel = str(path.relative_to(SKILL_DIR))
        assert rel in routed, f"{rel} is in the skill but no routing row mentions it"


def test_the_three_phases_run_in_order():
    phases = sorted(p.name for p in (SKILL_DIR / "phases").glob("*.md"))
    assert phases == ["1-scan.md", "2-classify.md", "3-bundle.md"]


def test_every_phase_file_inlines_the_same_ground_rules():
    index_rules = INDEX.read_text(encoding="utf-8").split("> **Ground rules")[1].split("\n\n")[0]
    for phase in sorted((SKILL_DIR / "phases").glob("*.md")):
        text = phase.read_text(encoding="utf-8")
        assert "Ground rules (inline by design" in text, f"{phase.name} lost its ground rules"
        rules = text.split("> **Ground rules")[1].split("\n\n")[0]
        assert rules == index_rules, f"{phase.name}'s ground rules drifted from SKILL.md"


def test_the_tiers_are_the_three_the_user_named():
    text = (SKILL_DIR / "phases/2-classify.md").read_text(encoding="utf-8")
    for tier in ("**MUST**", "**USEFUL**", "**EXTRA**"):
        assert tier in text, f"2-classify.md never defines {tier}"


def test_bundling_writes_only_through_declare():
    # `flow credentials declare` writes the folder AND indexes the row with its
    # declared scope + project. A generic re-index re-derives both from the path
    # (proven on a live instance 2026-09-28: root index stamped the legacy
    # uuid5(path) project id, folder index flipped scope to `user`), so the
    # phase must never tell the agent to run one as a command.
    text = (SKILL_DIR / "phases/3-bundle.md").read_text(encoding="utf-8")
    assert "flow credentials declare" in text
    assert "--types credential" not in text


def test_the_skill_never_reaches_for_the_navigating_verb():
    forbidden = "flow " + "navigate"
    for path in [INDEX, *_authored_files()]:
        if path.suffix == ".md":
            assert forbidden not in path.read_text(encoding="utf-8"), path.name


def test_the_description_carries_the_triggering_burden():
    fm = yaml.safe_load(INDEX.read_text(encoding="utf-8").split("---")[1])
    description = fm["description"]
    assert fm["name"] == "cred-scan"
    assert 200 < len(description) <= 1024
    for phrase in ("credential", "env var", "api key", "secret", "must", "useful", "extra"):
        assert phrase in description.lower(), f"the description never mentions {phrase!r}"
    assert "NOT for" in description


def test_the_index_stays_an_index():
    assert len(INDEX.read_text(encoding="utf-8").splitlines()) < 150
