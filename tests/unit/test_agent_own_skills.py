"""An agent's own skills (``<agent>/skills/<name>``) reach its session; the project replaces one by name."""
from __future__ import annotations

from flow_sdk.assets.process_projection import link_mounted_skills


def _skill(root, name):
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text(f"---\nname: {name}\n---\n")
    return folder


def test_the_agents_skill_is_linked_unless_the_project_has_one_of_that_name(tmp_path):
    workdir, agent_skills, assets = tmp_path / "project", tmp_path / "agent" / "skills", tmp_path / "assets"
    _skill(agent_skills, "pr-review")
    _skill(agent_skills, "triage")
    _skill(workdir / ".claude" / "skills", "pr-review")  # the project's own replaces the agent's

    assert link_mounted_skills(assets, [str(workdir)], native_mount=".claude/skills", own=[str(agent_skills)])
    linked = {p.name: p.resolve() for p in (assets / ".claude" / "skills").iterdir()}
    assert linked == {"triage": (agent_skills / "triage").resolve()}
