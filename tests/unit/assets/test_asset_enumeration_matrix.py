"""Filesystem enumeration across declared asset families, without indexing.

The existing asset-tree fixture covers four types. This matrix exercises the
remaining folder/file shapes and nested mounts through the public SDK scanner.
"""

import json
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets import Asset, AssetFolder
from flow_sdk.assets.folder import AssetScanError
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.layout import Folder
from flow_sdk.schema.types import EntityType
from tests.fixtures.asset_tree import write_asset

# Runtime fragments and journals do not declare path-addressable discovery.
# Adding a new extractor without a mount/named file must document that choice.
EXCLUDED_EXTRACTORS = {
    "claude_hook": "a JSON fragment needs its configuration ref",
    "mcp_server": "a JSON fragment needs its configuration ref",
    "plugin": "a JSON fragment needs its configuration ref",
    "claude_memory": "runtime project-memory roots have no generic mount declaration",
    "project": "Project identity is application scope, not a declared asset mount",
    "workflow_run": "provider runtime journals have no generic mount declaration",
}
REGISTERED = {
    name: SchemaRegistry.get(name) for name in SchemaRegistry.get_all_types()
    if name in {str(value) for value in EntityType} and SchemaRegistry.get(name).from_disk_fn is not None
}
ENUMERABLE = {
    name: info for name, info in REGISTERED.items()
    if info.shape is not None and not info.keyed_by_ref
    and (info.scan_mounts or getattr(info.shape, "names", ()))
}
CASES = [(name, mount) for name, info in sorted(ENUMERABLE.items()) for mount in (info.scan_mounts or (None,))]


def _write(root: Path, type_name: str, *, mount: str | None = None, name: str = "fixture") -> Path:
    info = SchemaRegistry.get(type_name)
    family = root / (mount or next(iter(info.scan_mounts), ".")).replace("*", "bundled-skill")
    if isinstance(info.shape, Folder):
        path = family if info.singleton else family / name
        main = path / info.shape.main
    else:
        path = main = family / (next(iter(info.shape.names), None) or name + info.shape.ext)
    main.parent.mkdir(parents=True, exist_ok=True)
    identity = mint_uuid()
    if main.suffix == ".md":
        body = f"---\nid: {identity}\ntype: {type_name}\nname: {name}\ntitle: Fixture\n---\nBody\n"
    elif main.suffix == ".js":
        body = f"export const meta = {{id: '{identity}', name: '{name}'}};\n"
    elif main.suffix == ".csv":
        body = "name,value\nfixture,1\n"
    elif type_name == "secret_origin":
        body = json.dumps({"data": {"project_id": identity, "env_var": "FIXTURE_TOKEN", "locator": {"kind": "local", "sod_name": "fixture"}}})
    elif type_name == "claude_session":
        body = json.dumps({"sessionId": identity}) + "\n"
    elif type_name == "codex_session":
        body = json.dumps({"type": "session_meta", "payload": {"id": identity}}) + "\n"
    else:
        body = json.dumps({"id": identity, "name": name})
    main.write_text(body, encoding="utf-8")
    return path


def test_every_registered_extractor_has_enumeration_coverage_or_explicit_exclusion():
    assert set(REGISTERED) - set(ENUMERABLE) == set(EXCLUDED_EXTRACTORS)


@pytest.mark.parametrize("type_name,mount", CASES)
def test_declared_family_is_enumerated_from_scope_container_and_family(tmp_path, type_name, mount):
    path = _write(tmp_path, type_name, mount=mount)
    expected = (type_name, path.resolve())
    family = path if SchemaRegistry.get(type_name).singleton else path.parent
    roots = (tmp_path, family.parent, family) if mount is not None else (tmp_path, path)
    for root in roots:
        found = AssetFolder(path=root, project_id="fixture-project").assets()
        assert [(asset.typeid.type, asset.path) for asset in found] == [expected]
        assert found[0].project_id == "fixture-project"
    if mount is not None:
        assert AssetFolder(path=family).destination_for(found[0]) == path


@pytest.mark.parametrize("type_name,filename", [
    (name, filename) for name, info in sorted(ENUMERABLE.items()) for filename in getattr(info.shape, "names", ())
])
def test_every_declared_fixed_filename_is_enumerated(tmp_path, type_name, filename):
    path = tmp_path / filename
    path.write_text(f"---\nid: {mint_uuid()}\n---\nProvider instructions\n")
    assert [(a.typeid.type, a.path) for a in AssetFolder(path=tmp_path).assets()] == [(type_name, path.resolve())]


@pytest.mark.parametrize("provider", (".agents", ".claude", ".github"))
def test_shared_skill_and_subagent_mounts_preserve_provider_occurrences(tmp_path, provider):
    skill = _write(tmp_path, "skill", mount=f"{provider}/skills")
    subagent = _write(tmp_path, "subagent", mount=f"{provider}/agents")
    found = AssetFolder(path=tmp_path / provider).assets()
    assert {(asset.typeid.type, asset.path) for asset in found} == {
        ("skill", skill.resolve()), ("subagent", subagent.resolve()),
    }


def test_existing_asset_tree_writer_agrees_with_sdk_enumeration(tmp_path):
    types = ("skill", "subagent", "markdown", "task", "plan", "claude_rules", "whiteboard")
    expected = {(name, write_asset(tmp_path, name, name).resolve()) for name in types}
    assert {(asset.typeid.type, asset.path) for asset in AssetFolder(path=tmp_path).assets()} == expected


def test_skill_bundled_workflow_is_a_declared_child_but_readme_is_support(tmp_path):
    skill = _write(tmp_path, "skill", mount=".claude/skills")
    workflow = skill / "flow.js"
    workflow.write_text("export const meta = {name: 'flow'};\n")
    (skill / "README.md").write_text("Supporting documentation")
    scripts = skill / "scripts"
    scripts.mkdir()
    helper = scripts / "helper.js"
    helper.write_text("console.log('support')")
    assert Asset.containing(workflow).path == workflow.resolve()
    assert AssetFolder(path=skill).destination_for(Asset.from_path(workflow)) == workflow
    with pytest.raises(ValueError, match="concrete"):
        AssetFolder(path=skill.parent).destination_for(Asset.from_path(workflow))
    assert Asset.containing(helper).path == skill.resolve()
    found = AssetFolder(path=tmp_path, recursive=True).assets()
    assert {(asset.typeid.type, asset.path) for asset in found} == {
        ("skill", skill.resolve()), ("dynamic_workflow", workflow.resolve()),
    }


def test_nested_native_family_keeps_child_identity_and_support_ownership(tmp_path):
    parent = _write(tmp_path, "data_source_spec")
    child = _write(parent, "micro_app", name="editor")
    support = parent / "README.md"
    support.write_text("Supporting data-source documentation")
    assert Asset.containing(child / "webapp.json").path == child.resolve()
    assert Asset.containing(support).path == parent.resolve()
    assert {(asset.typeid.type, asset.path) for asset in AssetFolder(path=tmp_path, recursive=True).assets()} == {
        ("data_source_spec", parent.resolve()), ("micro_app", child.resolve()),
    }


@pytest.mark.parametrize("relative", (".claude", ".claude/skills", "agentic-assets/mcp"))
def test_broken_declared_mount_is_diagnostic_not_an_empty_inventory(tmp_path, relative):
    broken = tmp_path / relative
    broken.parent.mkdir(parents=True, exist_ok=True)
    broken.symlink_to(tmp_path / "missing-target", target_is_directory=True)
    with pytest.raises(AssetScanError) as error:
        AssetFolder(path=tmp_path).assets()
    assert any(issue.path == broken for issue in error.value.issues)
    assert broken.is_symlink()


def test_missing_optional_family_remains_empty(tmp_path):
    assert AssetFolder(path=tmp_path / ".claude" / "skills").assets() == []
    assert AssetFolder(path=tmp_path).assets() == []


@pytest.mark.parametrize("relative", ("agentic-assets/mcp/empty", "agentic-assets/project_manifest"))
def test_empty_declared_folder_is_not_an_identity_carrier(tmp_path, relative):
    path = tmp_path / relative
    path.mkdir(parents=True)
    assert AssetFolder(path=tmp_path).assets() == []


def test_dependency_ledger_does_not_require_a_published_manifest(tmp_path):
    path = tmp_path / "agentic-assets/project_manifest"
    path.mkdir(parents=True)
    (path / "deps.json").write_text('{"entries": []}')
    assert AssetFolder(path=tmp_path).assets() == []


def test_explicit_mount_retains_broken_parent_link_diagnostic(tmp_path):
    provider = tmp_path / ".claude"
    provider.symlink_to(tmp_path / "absent", target_is_directory=True)
    with pytest.raises(AssetScanError) as error:
        AssetFolder(path=provider / "skills").assets()
    assert [issue.path for issue in error.value.issues] == [provider]


def test_missing_main_with_existing_capsule_is_a_malformed_declared_asset(tmp_path):
    path = _write(tmp_path, "mcp")
    capsule = path / ".flow" / "capsules" / "identity.json"
    capsule.parent.mkdir(parents=True)
    capsule.write_text(json.dumps({"id": mint_uuid()}))
    (path / "mcp.json").unlink()
    with pytest.raises(AssetScanError) as error:
        AssetFolder(path=tmp_path).assets()
    assert any(issue.path == path.resolve() for issue in error.value.issues)
    assert capsule.exists()


def test_malformed_json_identity_is_reported_once_from_overlapping_mounts(tmp_path):
    path = _write(tmp_path, "mcp")
    capsule = path / ".flow" / "capsules" / "identity.json"
    capsule.parent.mkdir(parents=True)
    capsule.write_text("{malformed")
    with pytest.raises(AssetScanError) as error:
        AssetFolder(path=tmp_path, recursive=True).assets()
    assert [issue.path for issue in error.value.issues] == [path.resolve()]
    assert capsule.read_text() == "{malformed"
