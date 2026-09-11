"""Asset contracts use real files and filesystem records, without an app DB."""
import json

import pytest
from pydantic import ValidationError

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets import Asset, AssetFolder
from flow_sdk.assets.asset import AssetIdentityMismatch
from flow_sdk.assets.folder import collect_assets
from flow_sdk.assets.materialize import MaterializationMode
from flow_sdk.fs_store.record_paths import shadow_dir_for


def skill(path, identity=None):
    path.mkdir(parents=True)
    header = f"---\nid: {identity}\n---\n" if identity else ""
    (path / "SKILL.md").write_text(header + "Skill body\n")
    return path


def test_main_file_and_containing_support_file_have_one_identity(tmp_path):
    root = skill(tmp_path / "source", mint_uuid())
    nested = root / "references"
    nested.mkdir()
    (nested / "guide.md").write_text("support")
    asset = Asset.from_path(root, project_id="project")
    assert Asset.from_path(root / "SKILL.md").typeid == asset.typeid
    assert Asset.containing(nested / "guide.md").path == asset.path
    assert asset.project_id == "project"


def test_read_identity_is_stable_without_stamping_missing_or_foreign_id(tmp_path):
    for name, identity in (("missing", None), ("foreign", "not-an-id")):
        path = skill(tmp_path / name, identity)
        before = (path / "SKILL.md").read_bytes()
        first = Asset.from_path(path)
        assert Asset.from_path(path).typeid == first.typeid
        assert first.typeid.id[14] == "5"
        assert (path / "SKILL.md").read_bytes() == before


def test_identity_cannot_be_supplied_independently(tmp_path):
    asset = Asset.from_path(skill(tmp_path / "source", mint_uuid()))
    with pytest.raises(ValidationError, match="identity does not match"):
        Asset(path=asset.path, typeid=f"skill-{mint_uuid()}")
    assert Asset.model_validate(asset.model_dump(mode="json")) == asset


def test_serialized_usage_validates_file_identity_on_reload(tmp_path):
    from flow_sdk.assets.usage import AssetUsage

    asset = Asset.from_path(skill(tmp_path / "source", mint_uuid()))
    usage = AssetUsage(asset=asset, reference=str(asset.path), resolution="resolved", evidence=[])
    serialized = usage.model_dump(mode="json")
    assert AssetUsage.model_validate(serialized) == usage
    (asset.path / "SKILL.md").write_text(f"---\nid: {mint_uuid()}\n---\nReplacement")
    with pytest.raises(ValidationError, match="identity does not match"):
        AssetUsage.model_validate(serialized)


def test_typeid_uses_filesystem_record_and_validates_its_target(tmp_path):
    asset = Asset.from_path(skill(tmp_path / "source", mint_uuid()))
    record_dir = shadow_dir_for(asset.typeid.type, asset.typeid.id)
    record_dir.mkdir(parents=True)
    metadata = record_dir / "metadata.json"
    metadata.write_text(json.dumps({"type": asset.typeid.type, "id": asset.typeid.id, "asset_ref": str(asset.path)}))
    assert Asset.from_typeid(asset.typeid).path == asset.path
    other = skill(tmp_path / "other", mint_uuid())
    metadata.write_text(json.dumps({"type": asset.typeid.type, "id": asset.typeid.id, "asset_ref": str(other)}))
    with pytest.raises(AssetIdentityMismatch):
        Asset.from_typeid(asset.typeid)
    metadata.unlink()
    with pytest.raises(FileNotFoundError):
        Asset.from_typeid(asset.typeid)


def test_exact_destination_copy_keeps_source_and_identity(tmp_path):
    source = skill(tmp_path / "source")
    asset = Asset.from_path(source, project_id="source-project")
    before = (source / "SKILL.md").read_bytes()
    installed = asset.install(tmp_path / "chosen-name")
    assert installed.path == (tmp_path / "chosen-name").resolve()
    assert installed.typeid == asset.typeid
    assert installed.project_id is None
    assert (source / "SKILL.md").read_bytes() == before


def test_link_is_an_occurrence_and_removal_preserves_source(tmp_path):
    source = Asset.from_path(skill(tmp_path / "source", mint_uuid()))
    linked = source.install(tmp_path / "alias", mode=MaterializationMode.LINK)
    assert linked.path != source.path
    assert linked.resolved_path == source.path
    assert linked.typeid == source.typeid
    assert Asset.from_path(linked.path / "SKILL.md").path == linked.path
    assert Asset.containing(linked.path / "SKILL.md").path == linked.path
    linked.remove()
    assert source.path.exists() and not linked.path.is_symlink()


def test_source_change_and_destination_conflict_preserve_existing_bytes(tmp_path):
    asset = Asset.from_path(skill(tmp_path / "source", mint_uuid()))
    installed = asset.install(tmp_path / "destination")
    before = (installed.path / "SKILL.md").read_bytes()
    with pytest.raises(FileExistsError):
        asset.install(installed.path)
    (asset.path / "SKILL.md").write_text(f"---\nid: {mint_uuid()}\n---\nchanged")
    with pytest.raises(AssetIdentityMismatch):
        asset.install(installed.path, overwrite=True)
    assert (installed.path / "SKILL.md").read_bytes() == before


def test_registered_mounts_and_overlaps_preserve_same_id_copies(tmp_path):
    identity = mint_uuid()
    first = skill(tmp_path / ".claude" / "skills" / "one", identity)
    second = skill(tmp_path / ".agents" / "skills" / "two", identity)
    folders = [AssetFolder(path=tmp_path, project_id="project"), AssetFolder(path=tmp_path / ".claude")]
    assets = collect_assets(folders)
    assert {a.path for a in assets} == {first.resolve(), second.resolve()}
    assert all(a.project_id == "project" for a in assets)
    assert len({str(a.typeid) for a in assets}) == 1


def test_missing_root_and_recursive_symlink_cycle(tmp_path):
    assert AssetFolder(path=tmp_path / "absent").assets() == []
    path = skill(tmp_path / "group" / "skill", mint_uuid())
    (tmp_path / "group" / "cycle").symlink_to(tmp_path, target_is_directory=True)
    assert [a.path for a in AssetFolder(path=tmp_path, recursive=True).assets()] == [path.resolve()]


def test_destination_uses_supplied_provider_folder(tmp_path):
    asset = Asset.from_path(skill(tmp_path / "source", mint_uuid()))
    assert AssetFolder(path=tmp_path / ".claude").destination_for(asset) == tmp_path / ".claude" / "skills" / "source"
    with pytest.raises(ValueError, match="Choose"):
        AssetFolder(path=tmp_path).destination_for(asset)


def test_single_file_asset_install_preserves_registered_type(tmp_path):
    source = tmp_path / "first" / ".claude" / "agents" / "review.md"
    source.parent.mkdir(parents=True)
    source.write_text(f"---\nid: {mint_uuid()}\nname: reviewer\n---\nReview code.")
    asset = Asset.from_path(source)
    destination = tmp_path / "second" / ".claude" / "agents" / "review.md"
    assert asset.install(destination).typeid == asset.typeid
    assert source.read_bytes() == destination.read_bytes()


def test_install_rejects_self_alias_and_reserved_staging_name_is_safe(tmp_path):
    asset = Asset.from_path(skill(tmp_path / "source", mint_uuid()))
    alias = asset.install(tmp_path / "alias", mode=MaterializationMode.LINK)
    with pytest.raises(ValueError, match="overlap"):
        alias.install(alias.path, overwrite=True)
    previous = asset.install(tmp_path / "previous")
    assert asset.install(previous.path, overwrite=True).typeid == asset.typeid


def test_malformed_declared_carrier_is_reported_without_modifying_it(tmp_path):
    from flow_sdk.assets.folder import AssetScanError
    path = tmp_path / "agentic-assets" / "mcp" / "broken"
    path.mkdir(parents=True)
    (path / "mcp.json").write_text('{}')
    capsule = path / ".flow" / "capsules" / "identity.json"
    capsule.parent.mkdir(parents=True)
    capsule.write_text('{broken')
    with pytest.raises(AssetScanError) as error:
        AssetFolder(path=tmp_path).assets()
    assert len(error.value.issues) == 1
    assert error.value.issues[0].path == path.resolve()
    assert capsule.read_text() == '{broken'
