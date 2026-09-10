"""The manifest as an asset: disk → indexed entity with a v4 sidecar id, and
the reconcile that keeps ``Entity.published`` a faithful cache of the file.

The file is the truth. Every scenario here changes the FILE (or the asset it
names) and asserts the rows follow; nothing ever writes the flag directly.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401  (register types)
from flow_sdk.assets.project_manifest import (
    MANIFEST_REL_PATH,
    make_entry,
    manifest_dir,
    manifest_path,
    publish,
    read_manifest,
    unpublish,
)
from flow_sdk.builtin.project_manifest import ProjectManifest
from flow_sdk.builtin.skill import Skill
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(5)]  # do not increase timeout without approval


@pytest.fixture
def home(tmp_path: Path, monkeypatch):
    """A sandbox scope root (mirrors ``test_mcp_asset.py``)."""
    from flow_sdk.config import default_service_config
    from flow_sdk.fs_store.record_paths import (
        get_default_records_data_root,
        get_default_records_root,
        set_default_records_data_root,
        set_default_records_root,
    )
    from flow_sdk.instance_settings import reset_instance_settings
    from flow_sdk.request_context import methods as _ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    root = tmp_path / "home"
    root.mkdir()
    records = tmp_path / "records"
    records.mkdir()
    orig_root, orig_data = get_default_records_root(), get_default_records_data_root()
    set_default_records_root(records)
    set_default_records_data_root(records)
    monkeypatch.setenv("HOME", str(root))
    monkeypatch.setenv("USERPROFILE", str(root))
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(root))
    prev_dev = default_service_config.development
    default_service_config.development = True
    _ctx.set_default_test_storage_fallback(LocalStorageDriver(str(records / "blobs")))
    reset_instance_settings()
    try:
        yield root
    finally:
        _ctx.set_default_test_storage_fallback(None)
        default_service_config.development = prev_dev
        set_default_records_root(orig_root)
        set_default_records_data_root(orig_data)
        reset_instance_settings()


@pytest.fixture
def project_id() -> str:
    """Unique per test: the DB is session-scoped."""
    return str(uuid.uuid4())


async def _index(root: Path, project_id: str) -> None:
    from flow_sdk.builtin.flow_message_bundle import _reindex_root

    await _reindex_root(
        root, RecordType.REAL_PROJECT_CWD, types=(RecordType.SKILL, RecordType.PROJECT_MANIFEST), project_id=project_id
    )


def _write_skill(root: Path, name: str) -> Path:
    d = root / ".claude" / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: a {name}\n---\n\n# {name}\n", encoding="utf-8")
    return d


async def _skill(project_id: str, name: str) -> Skill:
    row = await Skill.get_one({"name": name, "project_id": project_id})
    assert row is not None, f"skill {name!r} was not indexed"
    return row


async def _manifest_row(project_id: str) -> ProjectManifest:
    row = await ProjectManifest.get_one({"project_id": project_id})
    assert row is not None, "the manifest was not indexed"
    return row


# ── disk → entity ────────────────────────────────────────────────────────────


async def test_the_type_is_a_singleton_repo_asset():
    info = SchemaRegistry.get("project_manifest")
    assert info is not None and info.singleton and info.entity_cls is ProjectManifest
    assert info.scan_mounts == ("agentic-assets/project_manifest",)
    SchemaRegistry.check_asset_specs()   # the spec and the row agree


async def test_a_manifest_becomes_an_indexed_entity_with_a_v4_sidecar_id(home, project_id):
    _write_skill(home, "rca")
    skill_typeid = f"skill-{uuid.uuid4()}"
    publish(home, make_entry(typeid=skill_typeid, rel_path=".claude/skills/rca", name="rca"))
    await _index(home, project_id)

    row = await _manifest_row(project_id)
    assert uuid.UUID(row.id).version == 4
    assert Path(row.asset_ref) == manifest_dir(home), "the entity-type dir IS the asset"
    assert [e.typeid for e in row.entries] == [skill_typeid]
    capsule = manifest_dir(home) / ".flow" / "capsules" / "identity.json"
    assert json.loads(capsule.read_text())["data"]["id"] == row.id

    await _index(home, project_id)
    assert (await _manifest_row(project_id)).id == row.id, "a rescan must not mint a second manifest"


# ── the file is the truth; the flag follows ──────────────────────────────────


async def test_publishing_sets_the_cache_and_unpublishing_clears_it(home, project_id):
    _write_skill(home, "rca")
    await _index(home, project_id)
    skill = await _skill(project_id, "rca")
    assert skill.published is False
    before = (home / ".claude" / "skills" / "rca" / "SKILL.md").read_bytes()

    publish(home, make_entry(typeid=f"skill-{skill.id}", rel_path=".claude/skills/rca", name="rca"))
    await _index(home, project_id)
    assert (await _skill(project_id, "rca")).published is True
    assert (home / ".claude" / "skills" / "rca" / "SKILL.md").read_bytes() == before, (
        "the flag is a row fact; the reconcile must never rewrite the asset's own file"
    )

    unpublish(home, f"skill-{skill.id}")
    await _index(home, project_id)
    assert (await _skill(project_id, "rca")).published is False


async def test_a_moved_asset_gets_its_rel_path_repaired_once(home, project_id):
    _write_skill(home, "rca")
    await _index(home, project_id)
    skill = await _skill(project_id, "rca")
    publish(home, make_entry(typeid=f"skill-{skill.id}", rel_path=".claude/skills/rca"))
    await _index(home, project_id)

    (home / ".claude" / "skills" / "rca").rename(home / ".claude" / "skills" / "rca-v2")
    await _index(home, project_id)
    spec = read_manifest(home)
    assert spec.find(f"skill-{skill.id}").rel_path == ".claude/skills/rca-v2"
    stamped = manifest_path(home).stat().st_mtime_ns
    await _index(home, project_id)
    assert manifest_path(home).stat().st_mtime_ns == stamped, "the second pass converges without a write"


async def test_a_malformed_manifest_touches_no_row(home, project_id):
    _write_skill(home, "rca")
    await _index(home, project_id)
    skill = await _skill(project_id, "rca")
    publish(home, make_entry(typeid=f"skill-{skill.id}", rel_path=".claude/skills/rca"))
    await _index(home, project_id)
    assert (await _skill(project_id, "rca")).published is True

    manifest_path(home).write_text("{ this is not a manifest")
    await _index(home, project_id)
    assert (await _skill(project_id, "rca")).published is True, "a broken file is not an unpublish"


async def test_a_row_for_an_unindexed_asset_is_left_alone(home, project_id):
    """Pulled via git before indexing: the file names an id no row has yet."""
    publish(home, make_entry(typeid=f"skill-{uuid.uuid4()}", rel_path=".claude/skills/ghost"))
    await _index(home, project_id)
    assert len((await _manifest_row(project_id)).entries) == 1
    assert (home / MANIFEST_REL_PATH).exists()
