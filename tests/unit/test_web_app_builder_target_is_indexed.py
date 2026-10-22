"""An app built where ``web-app-builder`` (or ``light-web-app-builder``) says to build it is an app Flowpad knows.

``webapp.json`` is how Flowpad learns a folder IS an app — and so what starts its services
(``webapp_setup._start_all``: the ``api`` before the page, the page told the api's port). The
walker reads it only inside a family folder, ``<container>/agentic-assets/webapp/<name>/``
(``scan_repo_tree``). A skill that builds the app anywhere else ships an app nothing indexes:
the agent starts the page by hand, its ``api`` service never runs, and every ``/api`` call is
refused on the fallback port.

Driven through the real walker on the skill's real templates, at the directory the skill names.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

import pytest

from flow_sdk.assets.scanning import scan_repo_tree
from flow_sdk.fs_store.schema_registry import SchemaRegistry

SKILLS = Path(__file__).resolve().parents[2] / "flow_sdk/system_projects/flowpad_assistant/.claude/skills"
TARGET = re.compile(r"<project root>/([^`\"<]+)/<app name>")


def _targets(doc: Path) -> set[str]:
    return set(TARGET.findall(doc.read_text(encoding="utf-8")))


@pytest.mark.parametrize(
    ("skill", "template", "doc"),
    [
        ("web-app-builder", "template", "SKILL.md"),
        ("web-app-builder", "template-flowpad", "template-flowpad/README.md"),
        ("light-web-app-builder", "template", "SKILL.md"),
    ],
)
def test_the_skills_target_directory_is_one_flowpad_indexes_as_an_app(tmp_path, skill, template, doc):
    skill_dir = SKILLS / skill
    targets = _targets(skill_dir / doc)
    assert targets, f"{doc} names no `<project root>/…/<app name>` target"
    for target in targets:
        app = tmp_path / target / "todo-app"
        app.mkdir(parents=True)
        shutil.copy(skill_dir / template / "webapp.json", app / "webapp.json")

        found = scan_repo_tree(tmp_path, SchemaRegistry.repo_family_to_info()).candidates
        apps = [c for c in found if c.type_name == "micro_app" and Path(c.path).resolve() == app.resolve()]
        assert apps, f"an app built at {target}/todo-app is not indexed as an app"
        shutil.rmtree(tmp_path / target.split("/")[0])
