"""``FlowAsset`` — every declared field survives ``to_fs`` → ``from_fs``.

The probe classes here exercise every arm of the walker once: a file with a
spec and a ``Body``, a folder with a main file, a ``list[<file type>]``
directory, a nested folder type, and a ``SpecType`` field. A probe is a plain
``BaseModel`` whose shape is its registered ``TypeInfo.asset_spec``. Real types join the
parametrize list as they migrate.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import pytest
from pydantic import BaseModel

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.dataset import Dataset
from flow_sdk.fs_store.origin.local_origin import LocalOrigin, local_origin_for_path
from flow_sdk.builtin.subagent import SubAgent
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.serializer.disk import DiskSerializer
from flow_sdk.schema.data_spec import Body, FrontMatter, SpecType, to_authoring_form
from flow_sdk.schema.data_spec.dataset_spec import (
    DEFAULT_DATASET_SPEC,
    DataLayoutEnum,
    DatasetSpec,
    ExampleKind,
    FileRef,
)
from tests.unit.test_data_spec._roundtrip import (
    COMPARE,
    NOT_ON_DISK,
    OVERRIDES,
    assert_roundtrip,
    populate,
)

pytestmark = pytest.mark.timeout(5)  # do not increase without approval


# ── probes ────────────────────────────────────────────────────────────────────

class _LeafSpec(FrontMatter):
    name: str
    tools: list[str] = []
    model: Optional[str] = None
    prompt: Body = ""


class _Leaf(BaseModel):
    """A file asset: header + body + identity."""
    type: str = "probe_leaf"
    id: Optional[str] = None
    name: str = ""
    tools: list[str] = []
    model: Optional[str] = None
    prompt: str = ""
    db_only: int = 0                    # NOT on disk


class _InnerSpec(FrontMatter):
    title: str


class _Inner(BaseModel):
    type: str = "probe_inner"
    id: Optional[str] = None
    title: str = ""


class _RootSpec(FrontMatter):
    title: str
    input: Optional[SpecType] = None
    options: dict[str, str] = {}
    instructions: Body = ""


class _Root(BaseModel):
    """A folder asset with every content arm."""
    type: str = "probe_root"
    id: Optional[str] = None
    title: str = ""
    instructions: str = ""
    input: Optional[SpecType] = None
    options: dict[str, str] = {}
    leaves: list[_Leaf] = []
    inner: Optional[_Inner] = None
    db_only: int = 0                    # NOT on disk


NOT_ON_DISK[_Leaf] = {"db_only"}
NOT_ON_DISK[_Root] = {"db_only"}
# Entity plumbing that never reaches the .md — DB-side only.
def _spec_fields(cls: type) -> set[str]:
    return set(SchemaRegistry.get(cls.model_fields["type"].default).asset_spec.model_fields)


NOT_ON_DISK[SubAgent] = set(SubAgent.model_fields) - _spec_fields(SubAgent) - {"id"}
NOT_ON_DISK[Agent] = set(Agent.model_fields) - _spec_fields(Agent) - {"id", "name"}
NOT_ON_DISK[Dataset] = set(Dataset.model_fields) - _spec_fields(Dataset) - {"id", "examples"}
_Row = DEFAULT_DATASET_SPEC.example_type()
OVERRIDES[Dataset] = {
    "data_layout": DataLayoutEnum.IO_FOLDER,
    "spec": DatasetSpec.parse({"examples": [{"input": "file_ref", "output": "file_ref"}]}),
    "examples": [_Row(
        kind=ExampleKind.EVAL,
        input=FileRef(path="input.txt"),
        output=[FileRef(path="output-1.txt"), FileRef(path="output-2.txt")],
        # `kind` rides in example.json.metadata and is lifted-but-preserved on read
        # (the grammar's reserved-keys rule), so an authored row carries it too.
        metadata={"note": 1, "kind": "eval", "input.json": {"metadata": {"pages": 3}, "data": {}}},
        data={"x": 1},
    )],
}
# the written dir is named 0001, which re-mints the row id — compare rows without it
COMPARE[Dataset] = {"examples": lambda rows: [r.model_dump(mode="json", exclude={"id"}) for r in rows]}


def _register_probe_types() -> None:
    from flow_sdk.fs_store.identity_backend import CapsuleIdentityBackend
    from flow_sdk.fs_store.indexer.functions._asset_identity import IDENTITY_CAPSULE
    from flow_sdk.fs_store.schema_registry import TypeInfo

    for cls, spec, layout, main_file in (
        (_Leaf, _LeafSpec, "file", None), (_Inner, _InnerSpec, "folder", "inner.md"), (_Root, _RootSpec, "folder", "root.md"),
    ):
        info = TypeInfo(type_name=cls.model_fields["type"].default, capsules=(IDENTITY_CAPSULE,),
                        identity_backend=CapsuleIdentityBackend(), main_layout=layout, main_file=main_file,
                        main_file_is_asset_ref=bool(main_file), asset_spec=spec)
        info.entity_cls = cls
        SchemaRegistry.register(info)


# The probes are registered like every real type: identity through a
# CapsuleIdentityBackend, layout on TypeInfo. `type` is what _type_of reads.
_register_probe_types()


# ── the matrix ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("cls", [_Leaf, _Inner, _Root, SubAgent, Agent, Dataset])
def test_every_field_survives_the_filesystem(cls: type, tmp_path: Path) -> None:
    assert_roundtrip(cls, tmp_path)


def test_a_real_claude_agents_file_round_trips_byte_for_byte_in_meaning(tmp_path: Path) -> None:
    """The shipped ``.claude/agents/*.md`` files are the ground truth for the
    header. Read one, write it, read it again: same fields, same prompt, same id."""
    src = Path("flow_sdk/system_projects/flowpad_assistant/.claude/agents/asset-cleanup-wizard.md")
    ser = DiskSerializer()
    a = ser.load(SubAgent, local_origin_for_path(src))
    assert a.name == "asset-cleanup-wizard" and a.tools == "Bash, Read, Glob, Grep"
    assert a.id == "949de759-ead7-4838-a47e-047f48b51c1f"          # from the capsule block
    assert "Asset Cleanup Wizard" in a.prompt and "flowpad:capsule" not in a.prompt
    o = LocalOrigin(base=str(tmp_path), rel_path="copy.md")
    ser.store(a, o)
    b = ser.load(SubAgent, o)
    for f in _spec_fields(SubAgent) - {"prompt"}:
        assert getattr(b, f) == getattr(a, f), f
    assert b.prompt == a.prompt and b.id == a.id


def test_an_undeclared_field_is_not_written(tmp_path: Path) -> None:
    """DB-only fields never reach disk — the negative half of the contract."""
    target = assert_roundtrip(_Leaf, tmp_path)
    assert "db_only" not in target.read_text()


def test_an_undeclared_frontmatter_key_does_not_surface(tmp_path: Path) -> None:
    """``extra="ignore"``: a hand-added key the header does not declare is dropped
    on READ. On write it is dropped only when the entity OWNS the file — an
    unowned file is never re-rendered (that is the ``owns_main_ref`` policy), so
    the key survives there by design. Both halves pinned."""
    f = tmp_path / "x.md"
    f.write_text("---\nname: n\nstray: 1\n---\n\nbody\n")
    o = LocalOrigin(base=str(tmp_path), rel_path="x.md")
    leaf = DiskSerializer().load(_Leaf, o)
    assert leaf.name == "n" and leaf.prompt == "body"
    assert not hasattr(leaf, "stray")
    DiskSerializer().store(leaf, o)                      # _Leaf is unowned ⇒ the file is untouched
    assert "stray: 1" in f.read_text()
    DiskSerializer().store(leaf, o, force=True)          # an explicit edit re-renders ⇒ the key is dropped
    assert "stray" not in f.read_text()


def test_none_round_trips_as_absent(tmp_path: Path) -> None:
    """``None`` means inherit: it is not written as ``null``, and reads back as None."""
    leaf = _Leaf(name="n", model=None, prompt="p")
    o = LocalOrigin(base=str(tmp_path), rel_path="x.md")
    DiskSerializer().store(leaf, o)
    assert "model" not in (tmp_path / "x.md").read_text()
    assert DiskSerializer().load(_Leaf, o).model is None


def test_identity_is_a_capsule_not_frontmatter(tmp_path: Path) -> None:
    """Both layouts: the id lives in the capsule and NEVER in the header."""
    ser = DiskSerializer()
    leaf = populate(_Leaf); ser.store(leaf, LocalOrigin(base=str(tmp_path), rel_path="l.md"))
    root = populate(_Root); ser.store(root, LocalOrigin(base=str(tmp_path), rel_path="r"))
    for path, obj in ((tmp_path / "l.md", leaf), (tmp_path / "r" / "root.md", root)):
        text = path.read_text()
        assert f"id: {obj.id}" in text                       # inside the capsule block
        assert "flowpad:capsule identity" in text
        assert not text.split("---")[1].strip().startswith("id:")  # not a frontmatter key
    assert ser.load(_Leaf, LocalOrigin(base=str(tmp_path), rel_path="l.md")).id == leaf.id
    assert ser.load(_Root, LocalOrigin(base=str(tmp_path), rel_path="r")).id == root.id


def test_a_prestamped_carrier_wins_over_the_proposed_id(tmp_path: Path) -> None:
    """The FS winner wins (mirrors test_typeinfo_identity): a file already
    carrying a valid id keeps it, and ``store`` returns THAT id — the semantic
    change from the deleted ``write_id``, which overwrote the capsule."""
    ser = DiskSerializer()
    o = LocalOrigin(base=str(tmp_path), rel_path="l.md")
    first = populate(_Leaf)
    ser.store(first, o)
    second = populate(_Leaf)                              # a different id, same file
    committed = ser.store(second, o)
    assert committed.id == first.id != second.id
    assert ser.load(_Leaf, o).id == first.id


def test_a_list_of_file_assets_is_a_directory_of_files(tmp_path: Path) -> None:
    root = populate(_Root)
    DiskSerializer().store(root, LocalOrigin(base=str(tmp_path), rel_path="r"))
    leaf_dir = tmp_path / "r" / "leaves"
    assert sorted(p.name for p in leaf_dir.iterdir()) == [f"{root.leaves[0].name}.md"]
    assert (tmp_path / "r" / "inner" / "inner.md").is_file()


def test_render_is_what_store_writes(tmp_path: Path) -> None:
    """The ``default_body_fn`` half of the TypeInfo seam renders the same text."""
    leaf = populate(_Leaf)
    ser = DiskSerializer()
    ser.store(leaf, LocalOrigin(base=str(tmp_path), rel_path="x.md"))
    on_disk = (tmp_path / "x.md").read_text()
    rendered = ser.render(leaf)
    # identical modulo the capsule block to_fs appends
    assert on_disk.startswith(rendered.rstrip("\n"))


def test_the_shipped_agent_md_round_trips(tmp_path: Path) -> None:
    """``agentic-assets/agent/q/`` is the ground truth for the Agent layout."""
    src = Path("agentic-assets/agent/q")
    ser = DiskSerializer()
    a = ser.load(Agent, local_origin_for_path(src))
    assert a.name == "Q"                              # frontmatter `name:` wins; the folder is the fallback
    assert a.title == "QA manager" and a.enabled is True
    assert a.id == "004f3ab7-d33b-48c0-ae0e-6e61e181a343"   # the capsule block
    assert a.system_prompt.startswith("You are Q") and "flowpad:capsule" not in a.system_prompt
    o = LocalOrigin(base=str(tmp_path), rel_path="q")
    ser.store(a, o)
    b = ser.load(Agent, o)
    for f in _spec_fields(Agent) - {"system_prompt"}:
        assert getattr(b, f) == getattr(a, f), f
    assert (b.name, b.system_prompt, b.id) == (a.name, a.system_prompt, a.id)


def test_agent_io_contract_round_trips_as_yaml_and_stays_out_of_the_launch_hash(tmp_path: Path) -> None:
    a = Agent(name="clf", model="haiku", system_prompt="classify",
              input={"text": "string"}, output={"category": "string", "tags": ["string"]})
    o = LocalOrigin(base=str(tmp_path), rel_path="clf")
    DiskSerializer().store(a, o)
    text = (tmp_path / "clf" / "agent.md").read_text()
    assert "input:\n  text: string" in text                       # plain YAML, no keywords
    b = DiskSerializer().load(Agent, o)
    assert to_authoring_form(b.output) == {"category": "string", "tags": ["string"]}
    assert b.output.model_validate({"category": "x", "tags": ["a"]}).category == "x"
    # declaration only — the options bundle (md5'd into last_started_hash) is untouched
    assert a.to_agent_options().to_json() == Agent(name="clf", model="haiku").to_agent_options().to_json()
