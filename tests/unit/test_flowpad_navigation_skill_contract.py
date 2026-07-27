"""Trigger contract for the bundled Flowpad navigation skill."""

from pathlib import Path

import yaml


SKILL_PATH = (
    Path(__file__).resolve().parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/flowpad-navigation/SKILL.md"
)


def test_navigation_skill_description_covers_file_followups():
    source = SKILL_PATH.read_text(encoding="utf-8")
    frontmatter = yaml.safe_load(source.split("---", 2)[1])
    description = frontmatter["description"].lower()

    assert "file" in description
    assert "open it" in description
