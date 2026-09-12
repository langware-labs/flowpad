"""Filesystem decoding does not reinterpret inline configs as nested assets."""

import pytest

from flow_sdk.assets import Asset, AssetFolder
from flow_sdk.assets.folder import AssetScanError, collect_asset_scan, collect_assets
from flow_sdk.assets.serialization import read_asset_data, read_asset_parent
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.serializer.fields import FieldKind, field_kinds, field_persistence
from flow_sdk.schema.data_spec import Body, FrontMatter, SubAsset
from flow_sdk.schema.data_spec.mcp_spec import McpSpec
from flow_sdk.schema.data_spec.skill_spec import SkillSpec
from flow_sdk.schema.types import EntityType


class NestedAgentSpec(FrontMatter):
    child: SubAsset[SkillSpec]
    config: list[McpSpec] = []
    system_prompt: Body = ""


def test_nested_spec_tree_roundtrip_and_inline_config(tmp_path, monkeypatch):
    info = SchemaRegistry.get(EntityType.AGENT)
    monkeypatch.setattr(info, "asset_spec", NestedAgentSpec)
    field_kinds.cache_clear()
    assert field_persistence(list[McpSpec]) is FieldKind.SCALAR
    assert dict(field_kinds(NestedAgentSpec))["child"] is FieldKind.SUB_ASSET
    spec = NestedAgentSpec(child=SkillSpec(name="child", body="Nested body"), system_prompt="Parent body")
    asset = Asset.create(tmp_path / "agentic-assets/agent/parent", type=EntityType.AGENT, spec=spec)
    assert (asset.path / "child/SKILL.md").is_file()
    record = read_asset_data(asset.path, info)
    assert record.system_prompt == "Parent body"
    assert record.child["name"] == "child"
    assert record.child["body"] == "Nested body"


def test_scan_retains_valid_occurrences_and_reports_malformed_candidates(tmp_path):
    good = tmp_path / ".agents/skills/good"
    bad = tmp_path / ".claude/skills/bad"
    good.mkdir(parents=True)
    bad.parent.mkdir(parents=True)
    bad.symlink_to(tmp_path / "missing", target_is_directory=True)
    (good / "SKILL.md").write_text("---\nname: good\n---\nGood")
    scan = collect_asset_scan([AssetFolder(path=tmp_path), AssetFolder(path=good, project_id="project-context")])
    assert [asset.path for asset in scan.assets] == [good]
    assert scan.assets[0].project_id == "project-context"
    assert scan.issues and any(issue.path == bad for issue in scan.issues)
    with pytest.raises(AssetScanError):
        collect_assets([AssetFolder(path=tmp_path)])


def test_authored_parent_is_independent_of_folder_context(tmp_path):
    source = tmp_path / ".agents/skills/example"
    source.mkdir(parents=True)
    body = source / "SKILL.md"
    body.write_text("---\nname: example\n---\nBody")
    asset = Asset.from_path(source, project_id="unrelated-project")
    assert read_asset_parent(source, asset.info) is None
    parent = "agent-1b2d6c12-026e-456c-a9ab-ee66951758da"
    body.write_text(f"---\nname: example\nparent_type_id: {parent}\n---\nBody")
    assert str(read_asset_parent(source, asset.info)) == parent


@pytest.mark.asyncio
async def test_removed_authored_metadata_resets_row_without_resetting_db_state(tmp_path):
    from flow_sdk.api.api_types.identifier import mint_uuid
    from flow_sdk.builtin.subagent import SubAgent
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.fs_store.fs_ref import FSRef

    identity = mint_uuid()
    source = tmp_path / ".claude/agents/reviewer.md"
    source.parent.mkdir(parents=True)
    source.write_text(f"---\nid: {identity}\nname: reviewer\nmodel: sonnet\ndescription: prior\n---\nReview")
    info = SchemaRegistry.get(EntityType.SUBAGENT)
    first = info.from_disk_fn(FSRef(source), identity)[0]
    row = await Entity.from_record(first, notify=False)
    assert isinstance(row, SubAgent)
    assert row.model == "sonnet" and row.description == "prior"
    row.published = True
    await row.save()
    source.write_text(f"---\nid: {identity}\nname: reviewer\n---\nReview")
    second = info.from_disk_fn(FSRef(source), identity)[0]
    assert "model" not in second.meta_dict()
    refreshed = await Entity.from_record(second, notify=False)
    assert refreshed.model is None and refreshed.description is None
    assert refreshed.published is True
