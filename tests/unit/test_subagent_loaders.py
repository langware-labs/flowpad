"""The sub-agent loader priority chain — pinned for the first time."""
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.fs_store.operations import subagent as ops


def _agent(path: Path, name: str, desc: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\nname: {name}\ndescription: {desc}\n---\nBody\n", encoding="utf-8")


@pytest.fixture
def homes(tmp_path, monkeypatch):
    user = tmp_path / "user-agents"
    project = tmp_path / "project"
    monkeypatch.setattr(ops, "get_instance_settings", lambda: SimpleNamespace(claude_agents_dir=user))
    monkeypatch.setattr(ops, "load_system_subagent", lambda name: None)
    return user, project


def test_project_folder_beats_project_file_beats_user(homes):
    user, project = homes
    _agent(project / ".claude/agents/joe/joe.md", "joe", "project-folder")
    _agent(project / ".claude/agents/joe.md", "joe", "project-file")
    _agent(user / "joe.md", "joe", "user-file")
    assert ops.load_subagent("joe", project).description == "project-folder"
    (project / ".claude/agents/joe/joe.md").unlink()
    assert ops.load_subagent("joe", project).description == "project-file"
    assert ops.load_subagent("joe").description == "user-file"


def test_missing_and_unreadable_are_none(homes, tmp_path):
    user, _ = homes
    assert ops.load_subagent("nobody") is None
    bad = user / "bad.md"
    bad.parent.mkdir(parents=True)
    bad.write_bytes(b"\xff\xfe not utf-8")
    assert ops.load_subagent("bad") is None
