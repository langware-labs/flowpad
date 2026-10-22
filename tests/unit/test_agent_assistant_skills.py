"""An agent that picks some of the Flowpad Assistant's skills mounts only those.

Every harness discovers the assistant's skills through ONE mount (``resolved_add_dirs`` →
``<mount>/.claude/skills``), so the selection is proved on that mount: with ``assistant_skills``
set, the folder a worker gets lists exactly the picked skills and still carries the rest of the
assistant (docs, instructions, agents). Unset, the worker gets the real root, as before.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.assistant_view import including, is_assistant_view, skill_catalog
from flow_sdk.config import flowpad_assistant_project_root


@pytest.fixture(autouse=True)
def _views_in_tmp(monkeypatch, tmp_path):
    monkeypatch.setattr("flow_sdk.config.FLOWPAD_TEMP_DIR", str(tmp_path))


def _mount(skills: list[str] | None) -> Path:
    process = AgenticProcess(workdir="/tmp/wd", load_flowpad_assistant=True, assistant_skills=skills)
    return Path(process.resolved_add_dirs[0])


def test_a_picked_set_mounts_only_those_skills():
    mount = _mount(["web-tester", "web-app-builder"])

    assert sorted(p.name for p in (mount / ".claude" / "skills").iterdir()) == ["web-app-builder", "web-tester"]
    assert (mount / ".claude" / "skills" / "web-tester" / "SKILL.md").is_file()
    root = flowpad_assistant_project_root()
    for entry in [*root.iterdir(), *(root / ".claude").iterdir()]:
        if entry.name not in {".claude", "skills"}:
            assert (mount / entry.relative_to(root)).exists(), f"{entry.name} missing from the view"
    assert is_assistant_view(mount)


def test_unset_mounts_the_whole_assistant():
    assert _mount(None) == flowpad_assistant_project_root()


def test_the_same_set_reuses_one_view():
    assert _mount(["web-tester", "html-builder"]) == _mount(["html-builder", "web-tester"])


def test_an_empty_pick_mounts_no_skills():
    assert list((_mount([]) / ".claude" / "skills").iterdir()) == []


def test_the_catalog_is_every_shipped_skill():
    names = [s["name"] for s in skill_catalog()]
    assert {"web-tester", "web-app-builder", "task-management"} <= set(names)
    assert all(s["description"] for s in skill_catalog())


def test_a_launch_that_needs_a_skill_keeps_it_without_widening_all():
    assert including(["web-tester"], "task-management") == ["task-management", "web-tester"]
    assert including(None, "task-management") is None
