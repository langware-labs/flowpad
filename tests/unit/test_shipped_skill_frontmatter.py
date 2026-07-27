"""Every shipped skill must expose a parseable `description`.

This is not style policing. The agent routes to a skill by reading its
description out of the SKILL.md frontmatter; when the YAML fails to parse the
loader falls back to the file's H1 title, so the skill still *appears* in the
agent's list — with no description — and is simply never chosen again. Nothing
errors, nothing logs, and the only symptom is the agent quietly hand-rolling
what the skill exists to do.

That is exactly how `web-app-builder` lost its routing: a bare ``data: tasks``
inside a plain multi-line scalar. One unquoted colon disabled the skill.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

SYSTEM_PROJECTS = Path(__file__).resolve().parents[2] / "flow_sdk" / "system_projects"

SKILL_FILES = sorted(SYSTEM_PROJECTS.glob("*/.claude/skills/*/SKILL.md"))


def _skill_id(path: Path) -> str:
    return path.parent.name


def test_shipped_skills_are_discovered():
    """Guard the guard: a bad glob would make every case below vacuous."""
    assert SKILL_FILES, f"no SKILL.md found under {SYSTEM_PROJECTS}"


@pytest.mark.parametrize("skill_md", SKILL_FILES, ids=_skill_id)
def test_skill_frontmatter_parses_and_describes(skill_md: Path):
    text = skill_md.read_text(encoding="utf-8")
    assert text.startswith("---"), f"{skill_md} has no frontmatter block"

    _, frontmatter, _ = text.split("---", 2)
    try:
        meta = yaml.safe_load(frontmatter)
    except yaml.YAMLError as e:  # pragma: no cover - the failure we are guarding
        pytest.fail(
            f"{skill_md.parent.name}: frontmatter is not valid YAML, so the skill "
            f"ships with no description and can never be routed to.\n{e}"
        )

    assert isinstance(meta, dict), f"{skill_md.parent.name}: frontmatter is not a mapping"

    description = (meta.get("description") or "").strip()
    assert description, (
        f"{skill_md.parent.name}: empty description — the agent has nothing to route on"
    )
    # A title restated as a description ("Web App Builder") is the shape the H1
    # fallback produces; it carries no trigger information.
    assert len(description) > 40, (
        f"{skill_md.parent.name}: description is too short to route on: {description!r}"
    )
