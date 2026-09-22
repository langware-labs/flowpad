"""Spec-owned filesystem contracts preserve registration and wire behavior."""
from typing import ClassVar

import pytest

from flow_sdk.assets.layout import File, Folder, LayoutKind, shape_from_spec
from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo
from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.agent_spec import AgentSpec
from flow_sdk.schema.data_spec.agent_trace_spec import AgentTraceSpec
from flow_sdk.schema.data_spec.markdown_spec import ClaudeMdSpec
from flow_sdk.schema.data_spec.skill_spec import SkillSpec
from flow_sdk.schema.data_spec.source_item_spec import SourceItemSpec


@pytest.fixture
def isolated_registry(monkeypatch):
    SchemaRegistry.get("skill")
    for attr in ("_types", "_kinds", "_kind_of_shape"):
        monkeypatch.setattr(SchemaRegistry, attr, getattr(SchemaRegistry, attr).copy())
    return SchemaRegistry



@pytest.mark.parametrize("entity_first", [True, False])
def test_registration_order_preserves_spec_contract(entity_first, isolated_registry):
    declaration = TypeInfo(type_name="contract_probe", asset_spec=SkillSpec)
    binding = TypeInfo(type_name="contract_probe", entity_cls=object)
    for info in ([binding, declaration] if entity_first else [declaration, binding]):
        isolated_registry.register(info)
    resolved = isolated_registry.get("contract_probe")
    assert resolved.entity_cls is object
    assert resolved.shape == Folder(main="SKILL.md")
    assert resolved.from_disk_fn is not None
    assert resolved._authored_shape is None


def test_entity_document_defaults_follow_spec():
    info = TypeInfo(type_name="agent", asset_spec=AgentSpec)
    assert info.is_entity_document
    assert info.shape == Folder(main="agent.json")
    assert info.body_file == "system_prompt"
    assert info.identity_carrier is not None and info.asset_hash_fn is not None


@pytest.mark.parametrize("spec", [SkillSpec, AgentTraceSpec, ClaudeMdSpec, AgentSpec])
def test_wire_shape_roundtrip_needs_no_live_spec(spec):
    info = TypeInfo(type_name="probe", asset_spec=spec)
    restored = TypeInfo.from_dict(info.to_dict())
    assert restored.asset_spec is None
    assert restored.shape == info.shape
    assert restored.to_dict() == info.to_dict()


def test_claude_fixed_names_remain_files(tmp_path):
    info = TypeInfo(type_name="claude_md", asset_spec=ClaudeMdSpec)
    assert info.layout_of(tmp_path / "CLAUDE.local.md").kind is LayoutKind.FILE
    assert info.layout_of(tmp_path / "other.md").kind is LayoutKind.NONE


def test_spec_metadata_is_not_document_content():
    value = SkillSpec(name="example", body="instructions")
    metadata = {"main_file", "file_ext", "file_names", "file_extensions", "manifest_layout"}
    assert not metadata.intersection(value.model_dump())
    assert not metadata.intersection(SkillSpec.model_json_schema()["properties"])
    assert shape_from_spec(DataSpec) is None
    assert shape_from_spec(SourceItemSpec) is None
    assert TypeInfo(type_name="legacy", shape=File(".csv")).shape == File(".csv")


@pytest.mark.parametrize("kwargs", [
    {"asset_spec": SkillSpec, "shape": Folder("SKILL.md")},
    {"asset_spec": AgentTraceSpec, "manifest_layout": "flat"},
    {"asset_spec": SkillSpec, "manifest_layout": "flat"},
])
def test_typeinfo_cannot_redeclare_spec_contract(kwargs):
    with pytest.raises(ValueError, match="declared by asset_spec"):
        TypeInfo(type_name="duplicate", **kwargs)


def test_contradictory_spec_rejected():
    class Invalid(SkillSpec):
        file_ext: ClassVar[str | None] = ".md"
    with pytest.raises(ValueError, match="conflicts"):
        shape_from_spec(Invalid)


def test_additional_file_extensions_are_preserved():
    class Sheet(DataSpec):
        file_ext: ClassVar[str | None] = ".csv"
        file_extensions: ClassVar[tuple[str, ...]] = (".xlsx",)
    assert shape_from_spec(Sheet) == File(".csv", also=(".xlsx",))




def test_late_spec_binding_refreshes_cached_body(isolated_registry):
    info = TypeInfo(type_name="contract_agent", entity_cls=object)
    isolated_registry.register(info)
    assert info.body_file is None
    isolated_registry.register(TypeInfo(type_name=info.type_name, asset_spec=AgentSpec))
    assert info.body_file == "system_prompt"
    assert info.asset_hash_fn.args[0] is info


@pytest.mark.parametrize("spec_first", [True, False])
def test_conflicting_merge_does_not_poison_registry(isolated_registry, spec_first):
    typed = TypeInfo(type_name="contract_conflict", asset_spec=SkillSpec)
    legacy = TypeInfo(type_name="contract_conflict", shape=Folder("different.md"))
    first, second = (typed, legacy) if spec_first else (legacy, typed)
    isolated_registry.register(first)
    before = vars(first).copy()
    with pytest.raises(ValueError, match="declared by asset_spec"):
        isolated_registry.register(second)
    assert vars(first) == before


def test_spec_rebinding_cannot_desynchronize_kind_lookup(isolated_registry):
    original = TypeInfo(type_name="contract_kind", asset_spec=SkillSpec)
    isolated_registry.register(original)
    with pytest.raises(ValueError, match="Conflicting asset spec"):
        isolated_registry.register(TypeInfo(type_name=original.type_name, asset_spec=AgentTraceSpec))
    assert isolated_registry.kind_type(original.type_name) is original.asset_spec is SkillSpec


def test_all_declared_spec_bindings_are_aligned():
    from flow_sdk.core.loaders import load_entities
    from flow_sdk.fs_store.schema_registry import check_asset_spec, check_entity_layout

    load_entities()
    SchemaRegistry._ensure_entities_loaded()
    infos = [SchemaRegistry.get(name) for name in SchemaRegistry.get_all_types()]
    specs = [info for info in infos if info.declared and info.asset_spec is not None]
    assert specs
    for info in specs:
        assert info.entity_cls is not None, info.type_name
        check_asset_spec(info.type_name, info.entity_cls, info.asset_spec)
        assert SchemaRegistry.kind_type(info.type_name) is info.asset_spec, info.type_name
        if info.db_only:
            assert shape_from_spec(info.asset_spec) is None, info.type_name
            continue
        assert info.shape == shape_from_spec(info.asset_spec), info.type_name
        assert info.manifest_layout == info.asset_spec.manifest_layout, info.type_name
        assert info._authored_shape is None, info.type_name
        assert info._authored_manifest_layout is None, info.type_name
        if info.is_entity_document:
            check_entity_layout(info)


# External filenames/formats are compatibility facts, not inferred expectations.
@pytest.mark.parametrize("name,main,layout", [
    ("skill", "SKILL.md", None),
    ("task", "task.md", None),
    ("spec", "spec.md", None),
    ("agent_trace", "trace.json", "flat"),
    ("usage_report", "report.json", "flat"),
    ("asset_cleanup_report", "report.json", "flat"),
    ("agent", "agent.json", "entity"),
    ("data_source", "data_source.json", "entity"),
    ("compute_op", "compute_op.json", "entity"),
    ("dataset", "dataset.json", None),
    ("data_driver", "data_driver.json", None),
    ("mcp", "mcp.json", None),
    ("micro_app", "webapp.json", None),
    ("secret_pack", "secret_pack.json", None),
    ("project_manifest", "project_manifest.json", None),
])
def test_published_folder_contracts_remain_compatible(name, main, layout):
    info = SchemaRegistry.get(name)
    assert info.shape == Folder(main)
    assert info.manifest_layout == layout


@pytest.mark.parametrize("name", ["markdown", "prompt", "subagent", "claude_md"])
def test_published_file_contracts_remain_compatible(name):
    expected_names = ("CLAUDE.md", "CLAUDE.local.md") if name == "claude_md" else ()
    assert SchemaRegistry.get(name).shape == File(".md", names=expected_names)
