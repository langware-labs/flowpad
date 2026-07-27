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

from flow_sdk.fs_store.indexer.functions.skill import parse_skill_yaml_from_dir

SYSTEM_PROJECTS = Path(__file__).resolve().parents[2] / "flow_sdk" / "system_projects"

# Anything at or below this reads as the H1-title fallback ("Web App Builder"),
# which carries no trigger information for routing.
MIN_ROUTABLE_DESCRIPTION = 40

SKILL_FILES = sorted(SYSTEM_PROJECTS.glob("*/.claude/skills/*/SKILL.md"))


def _skill_id(path: Path) -> str:
    return path.parent.name


def test_shipped_skills_are_discovered():
    """Guard the guard: a bad glob would make every case below vacuous."""
    assert SKILL_FILES, f"no SKILL.md found under {SYSTEM_PROJECTS}"


@pytest.mark.parametrize("skill_md", SKILL_FILES, ids=_skill_id)
def test_skill_frontmatter_is_strictly_valid_yaml(skill_md: Path):
    """The frontmatter must parse under a STRICT reader.

    Flowpad's own loader is forgiving — on a YAML error it falls back to a
    line-based reader — but other consumers are not, and the fallback does not
    recover the value: it keeps only the first line of a multi-line scalar. That
    is how `web-app-builder` shipped broken. Its truncated first line was still
    69 characters, so a length check against the forgiving loader saw nothing
    wrong while the agent-facing list showed no description at all.

    So this is the assertion that actually catches it: the YAML must be valid,
    and then it does not matter which reader gets there first.
    """
    text = skill_md.read_text(encoding="utf-8")
    _, frontmatter, _ = text.split("---", 2)
    try:
        yaml.safe_load(frontmatter)
    except yaml.YAMLError as e:
        pytest.fail(
            f"{skill_md.parent.name}: frontmatter is not valid YAML, so strict readers "
            f"get no description and the skill becomes unroutable.\n{e}"
        )


@pytest.mark.parametrize("skill_md", SKILL_FILES, ids=_skill_id)
def test_skill_ships_a_routable_description(skill_md: Path):
    """And what the loader ends up with must be worth routing on.

    Complements the strict check above: `flow-diagnose` shipped
    ``description: ">"`` — perfectly valid YAML, and perfectly useless.
    """
    meta = parse_skill_yaml_from_dir(skill_md.parent)
    assert isinstance(meta, dict), f"{skill_md.parent.name}: frontmatter did not parse to a mapping"

    description = (meta.get("description") or "").strip()
    assert description, (
        f"{skill_md.parent.name}: the loader reads no description — the agent has "
        f"nothing to route on, and the skill is silently unreachable"
    )
    assert len(description) > MIN_ROUTABLE_DESCRIPTION, (
        f"{skill_md.parent.name}: description is too short to route on: {description!r}"
    )
