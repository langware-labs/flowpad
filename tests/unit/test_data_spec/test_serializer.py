"""``DataSerializer`` — HOW/WHERE resolved from an origin's kind.

Pinned: the registry resolves by kind; every type is served by the ONE disk
serializer (a type with no ``asset_spec`` renders via ``default_body_fn``); ``TypeInfo.serializer()`` honors an explicit origin over the default;
``field_persistence`` is the one type→persistence mapping; ``store`` returns
the origin carrying the committed id.
"""
from __future__ import annotations

from typing import Optional

import pytest

from flow_sdk.builtin.dataset import Dataset
from flow_sdk.builtin.db_origin import DbOrigin, HubOrigin
from flow_sdk.fs_store.origin.local_origin import LocalOrigin, local_origin_for_path
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.serializer import DataSerializer, FieldKind, field_persistence, get_serializer
from flow_sdk.fs_store.serializer.disk import DiskSerializer
from flow_sdk.schema.data_spec.dataset_spec import FileRef, FolderSpec, TextSpec

pytestmark = pytest.mark.timeout(5)  # do not increase without approval


def test_the_registry_resolves_by_origin_kind() -> None:
    assert isinstance(get_serializer("local"), DiskSerializer)
    assert isinstance(get_serializer("local"), DataSerializer)          # runtime-checkable protocol
    with pytest.raises(KeyError):
        get_serializer("nowhere")


def test_every_type_is_served_by_the_one_disk_serializer() -> None:
    """A type with no ``asset_spec`` is not a different serializer: it renders
    through ``default_body_fn`` (a ``.js`` template) and loads via ``from_disk_fn``."""
    import flow_sdk.builtin.agent  # noqa: F401 — attaches the entity class
    from flow_sdk.builtin.dynamic_workflow import DynamicWorkflow

    assert type(SchemaRegistry.get("agent").serializer()) is DiskSerializer
    assert type(SchemaRegistry.get("task").serializer()) is DiskSerializer
    dw = SchemaRegistry.get("dynamic_workflow")
    assert dw.asset_spec is None and dw.default_body_fn is not None
    text = dw.serializer().render(DynamicWorkflow(name="w", description="d"), dw)
    assert text and "export const meta" in text


def test_type_info_default_origin_kind_follows_db_only() -> None:
    assert SchemaRegistry.get("agent").default_origin_kind == "local"
    assert SchemaRegistry.get("data_source_cursor").default_origin_kind == "db"


def test_an_explicit_origin_overrides_the_default() -> None:
    info = SchemaRegistry.get("agent")
    assert info.serializer(LocalOrigin(base="/x", rel_path="a")).kind == "local"
    assert info.serializer(DbOrigin()).kind == "db"                       # the origin's kind wins over the default
    assert info.serializer(HubOrigin()).kind == "hub"


def test_local_origin_for_path_is_the_one_construction() -> None:
    o = local_origin_for_path("/root/agentic-assets/agent/q")
    assert (o.base, o.rel_path, o.kind, o.id) == ("/root/agentic-assets/agent", "q", "local", "")
    assert DiskSerializer.root(o).as_posix() == "/root/agentic-assets/agent/q"


def test_origins_carry_the_committed_id() -> None:
    assert DbOrigin(id="abc").id == "abc" and HubOrigin().id == ""


def test_field_persistence_is_the_one_type_to_persistence_mapping() -> None:
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.subagent import SubAgent

    assert field_persistence(Dataset.model_fields["examples"].annotation) is FieldKind.ROWS
    assert field_persistence(Dataset.model_fields["title"].annotation) is FieldKind.SCALAR
    assert field_persistence(Dataset.model_fields["spec"].annotation) is FieldKind.SCALAR   # a shape, not bytes
    assert field_persistence(Optional[FileRef]) is FieldKind.FILE_REF
    assert field_persistence(list[FolderSpec]) is FieldKind.FOLDER_SPEC
    assert field_persistence(TextSpec) is FieldKind.SCALAR
    assert field_persistence(Optional[SubAgent]) is FieldKind.SUB_ASSET
    assert field_persistence(list[SubAgent]) is FieldKind.SUB_ASSET_LIST
    assert field_persistence(Agent.model_fields["tools"].annotation) is FieldKind.SCALAR


def test_a_db_side_save_of_an_unowned_file_never_drops_its_frontmatter(tmp_path) -> None:
    """SubAgent does not own its file (``owns_main_ref=False``): a save from the
    DB side — where the entity carries none of the file's header — must leave
    the file alone. The old ``upsert_main_ref`` wrote iff absent; so must this.
    Regression: step 2 first shipped an unconditional ``to_fs`` that dropped
    ``model: sonnet`` on the first save."""
    import flow_sdk.builtin.subagent as sa

    md = tmp_path / "summarizer.md"
    md.write_text("---\nname: summarizer\ndescription: d\nmodel: sonnet\n---\n\nSummarize.\n")
    entity = sa.SubAgent(name="summarizer", asset_ref=str(md))          # model is NOT set here
    DiskSerializer().store(entity, local_origin_for_path(md), type_name="subagent")
    assert "model: sonnet" in md.read_text()


def test_an_owned_file_is_rerendered_on_every_save(tmp_path) -> None:
    """Agent owns ``agent.md``: an entity-side edit must reach disk."""
    from flow_sdk.builtin.agent import Agent

    folder = tmp_path / "q"
    a = Agent(name="q", title="one", system_prompt="p")
    o = local_origin_for_path(folder)
    DiskSerializer().store(a, o, type_name="agent")
    a.title = "two"
    DiskSerializer().store(a, o, type_name="agent")
    assert "title: two" in (folder / "agent.md").read_text()
