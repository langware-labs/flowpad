"""A new thing starts from its type's template; a borrowed checkout guards only tracked files."""
import subprocess
from types import SimpleNamespace

from flow_sdk.core.entity.entity_model import Entity, _git_tracks
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def test_template_fills_only_empty_fields():
    thing = SimpleNamespace(name="Joker", system_prompt="", description="mine")
    info = SimpleNamespace(template={"system_prompt": "You are {name}.", "description": "theirs"})
    Entity._apply_template(thing, info)
    assert thing.system_prompt == "You are Joker."
    assert thing.description == "mine"


def test_every_template_names_real_fields():
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.builtin.claude_memory_entities import Markdown  # noqa: PLC0415
    from flow_sdk.builtin.prompt import Prompt  # noqa: PLC0415
    from flow_sdk.builtin.skill import Skill  # noqa: PLC0415
    from flow_sdk.builtin.subagent import SubAgent  # noqa: PLC0415
    from flow_sdk.builtin.task import Task  # noqa: PLC0415

    for cls in (Agent, Markdown, Prompt, Skill, SubAgent, Task):
        info = SchemaRegistry.get(cls.get_type())
        assert info.template, cls.__name__
        assert set(info.template) <= set(cls.model_fields), cls.__name__


def test_git_tracks_only_committed_files(tmp_path):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    (tmp_path / "theirs.md").write_text("x")
    subprocess.run(["git", "add", "theirs.md"], cwd=tmp_path, check=True)
    assert _git_tracks(str(tmp_path / "theirs.md"))
    assert not _git_tracks(str(tmp_path / "agent" / "new" / "agent.json"))
