"""Routing integrity for the connect-data-source skill.

Modelled on `test_docit_skill_routing.py`. A skill's index is only useful if
every row points at a file that exists and every file is reachable from a row —
an orphan is a file the model will never read, and a dangling row is an
instruction to open something that is not there.

The third test pins the ground rules. They are inlined into every mode file on
purpose (the skillit structure rubric: "cross-cutting ground rules are inlined
redundantly, at the top of every file they govern"), which only works if they
cannot drift apart silently.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

SKILL_DIR = (
    Path(__file__).resolve().parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/connect-data-source"
)
INDEX = SKILL_DIR / "SKILL.md"

#: Directories that are not authored content. `flow-diagnose` has committed
#: `__pycache__/*.pyc`, so an unfiltered walk over a skill tree is a known trap.
IGNORED_DIRS = {".flow", "__pycache__"}


def _routed_paths(text: str) -> set[str]:
    """Every `modes/x.md`, `references/x.md`, `scripts/x.py` named in the index."""
    return set(re.findall(r"(?:modes|references|scripts)/[A-Za-z0-9_.-]+", text))


def _authored_files() -> list[Path]:
    return [
        p
        for p in SKILL_DIR.rglob("*")
        if p.is_file()
        and p != INDEX
        and not any(part in IGNORED_DIRS for part in p.relative_to(SKILL_DIR).parts)
    ]


def test_the_skill_is_installed_where_it_ships_from():
    # Guards the premise: a moved folder would make every test below vacuous.
    assert INDEX.is_file(), f"no SKILL.md at {SKILL_DIR}"


def test_every_routing_row_resolves():
    for ref in sorted(_routed_paths(INDEX.read_text(encoding="utf-8"))):
        assert (SKILL_DIR / ref).is_file(), f"SKILL.md routes to {ref}, which does not exist"


def test_no_unreachable_files():
    routed = _routed_paths(INDEX.read_text(encoding="utf-8"))
    for path in _authored_files():
        rel = str(path.relative_to(SKILL_DIR))
        assert rel in routed, f"{rel} is in the skill but no routing row mentions it"


def test_every_mode_file_inlines_the_ground_rules():
    for mode in sorted((SKILL_DIR / "modes").glob("*.md")):
        text = mode.read_text(encoding="utf-8")
        assert "Ground rules (inline by design)" in text, f"{mode.name} lost its ground rules"
        # The two that cause wrong answers rather than untidy ones.
        assert "poll_now" in text, f"{mode.name} must say poll_now is not proof"
        assert "never widen" in text.lower() or "never raise a timeout" in text.lower(), mode.name


def test_the_skill_never_reaches_for_the_navigating_verb():
    # VIBE-001 (`test_vibe_display_skill_routing.py`) fails any section about
    # opening things that names the navigating verb without also naming
    # `flow show`. Satisfied structurally: this skill never writes it at all and
    # defers that decision to `flowpad-navigation`.
    forbidden = "flow " + "navigate"
    for path in [INDEX, *_authored_files()]:
        if path.suffix != ".md":
            continue
        assert forbidden not in path.read_text(encoding="utf-8"), (
            f"{path.name} names the navigating verb — defer to flowpad-navigation instead"
        )


def test_the_description_carries_the_triggering_burden():
    fm = yaml.safe_load(INDEX.read_text(encoding="utf-8").split("---")[1])
    description = fm["description"]

    assert fm["name"] == "connect-data-source"
    # The routing trigger is the only thing the model sees before deciding.
    assert len(description) > 200
    for phrase in ("connect", "data source", "author", "debug", "list"):
        assert phrase in description.lower(), f"the description never mentions {phrase!r}"
    # Bounded: over-claiming erodes every future trigger.
    assert "NOT for" in description


def test_the_index_stays_an_index():
    # The structure rubric caps a routing index at ~300 lines however big the
    # tree grows; past that it is a manual and the rows stop being found.
    assert len(INDEX.read_text(encoding="utf-8").splitlines()) < 300
