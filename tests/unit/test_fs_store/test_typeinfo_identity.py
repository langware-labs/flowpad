"""Fast matrix for TypeInfo's identity policy across carriers."""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.capsules import AssetCapsule, CapsuleData
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identity_carrier import Derived, Foreign, Frontmatter, Sidecar
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.indexer.functions._asset_identity import frontmatter_identity
from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo
from flow_sdk.schema.layout import Folder
from tests.fixtures.identity import resolve_id

V4 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
V5 = str(uuid.uuid5(uuid.NAMESPACE_URL, "existing"))
V7 = "018f0000-0000-7000-8000-000000000000"


def _md_info(*, stable: bool = False) -> TypeInfo:
    return TypeInfo(
        type_name="probe",
        identity_carrier=Frontmatter(),
        id_stable_key_fn=(lambda ref: "stable-key") if stable else None,
    )


def _fm_id(path: Path):
    fm = _extract_frontmatter(path.read_text(encoding="utf-8"))
    return (_yaml_load(fm) or {}).get("id") if fm else None


@pytest.mark.parametrize("existing", [V4, V5])
def test_frontmatter_id_is_adopted_over_a_proposal(tmp_path: Path, existing: str) -> None:
    path = tmp_path / "asset.md"
    path.write_text(f"---\nid: {existing}\n---\nbody\n", encoding="utf-8")
    info = _md_info()
    assert info.read_id(FSRef(path)) == existing
    assert info.stamp_id(FSRef(path), V5) == existing


def test_folder_json_carrier_adopts_and_mints(tmp_path: Path) -> None:
    folder = tmp_path / "asset"
    folder.mkdir()
    info = TypeInfo(type_name="probe", shape=Folder(), identity_carrier=Sidecar())
    first = resolve_id(info, FSRef(folder))
    assert uuid.UUID(first).version == 4
    assert AssetCapsule.from_path(folder).read("identity") == CapsuleData(1, {"id": first})
    assert resolve_id(info, FSRef(folder)) == first


def test_absent_portable_identity_persists_one_v4(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body\n", encoding="utf-8")
    info = _md_info()
    first = resolve_id(info, FSRef(path))
    assert uuid.UUID(first).version == 4
    assert resolve_id(info, FSRef(path)) == first
    assert _fm_id(path) == first


def test_stable_policy_persists_v5_in_frontmatter(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body\n", encoding="utf-8")
    info = _md_info(stable=True)
    expected = str(uuid.uuid5(uuid.NAMESPACE_URL, "stable-key"))
    assert resolve_id(info, path) == expected
    assert info.read_id(path) == expected


@pytest.mark.parametrize("candidate", ["garbage", V7])
def test_invalid_frontmatter_id_uses_path_v5_and_preserves_bytes(tmp_path: Path, candidate: str) -> None:
    path = tmp_path / "asset.md"
    path.write_text(f"---\nid: {candidate}\n---\nbody\n", encoding="utf-8")
    before = path.read_bytes()
    expected = str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    assert resolve_id(_md_info(), path) == expected
    assert path.read_bytes() == before


def test_read_only_portable_asset_uses_path_v5_without_writing(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body\n", encoding="utf-8")
    assert resolve_id(_md_info(), FSRef(path, read_only=True)) == str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    assert _fm_id(path) is None


def test_proposed_id_is_persisted_but_filesystem_winner_wins(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body\n", encoding="utf-8")
    info = _md_info()
    assert info.stamp_id(path, V4) == V4
    assert info.stamp_id(path, V5) == V4
    with pytest.raises(ValueError, match="UUID v4 or v5"):
        info.stamp_id(path, V7)


def test_proposed_id_preserves_source_less_stable_type_identity(tmp_path: Path) -> None:
    path = tmp_path / "note.md"   # not "spec.md": that name is the spec type's main document
    path.write_text("body\n", encoding="utf-8")
    info = _md_info(stable=True)
    assert info.stamp_id(path, V4) == V4
    assert info.read_id(path) == V4


@pytest.mark.parametrize("payload", [{}, {"id": V4, "extra": True}, {"id": V4}])
def test_a_comment_capsule_is_a_retired_form_and_reads_foreign(tmp_path: Path, payload: dict) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body\n", encoding="utf-8")
    AssetCapsule.from_path(path).write("identity", CapsuleData(1, payload))
    info = TypeInfo(type_name="probe", identity_carrier=frontmatter_identity())
    assert info.read_id(path) is None
    assert isinstance(info.carrier.read(path), Foreign)


def test_folder_with_markdown_main_carries_its_id_in_that_document(tmp_path: Path) -> None:
    """A skill/task folder: the carrier is ``<folder>/<main_file>``'s frontmatter."""
    folder = tmp_path / "skill"
    folder.mkdir()
    main = folder / "PROBE.md"   # a probe must not borrow a real type's main-document name
    main.write_text(f"---\nid: {V4}\nname: s\n---\nbody\n", encoding="utf-8")
    info = TypeInfo(type_name="probe", shape=Folder(main="PROBE.md"), identity_carrier=frontmatter_identity())
    assert info.identity_carrier.locate(info.layout_of(folder)) == main
    assert info.identity_carrier.locate(info.layout_of(main)) == main
    assert info.read_id(FSRef(folder)) == V4
    assert resolve_id(info, FSRef(main)) == V4

    fresh = tmp_path / "fresh"
    fresh.mkdir()
    (fresh / "PROBE.md").write_text("body\n", encoding="utf-8")
    minted = resolve_id(info, FSRef(fresh))
    assert _fm_id(fresh / "PROBE.md") == minted
    assert not (fresh / ".flow").exists(), "no folder json is written for a markdown main"


def test_folder_backed_main_file_ref_normalizes_idempotently(tmp_path: Path) -> None:
    folder = tmp_path / "skill"
    folder.mkdir()
    main = folder / "SKILL.md"
    main.write_text("body\n", encoding="utf-8")
    info = TypeInfo(type_name="probe", shape=Folder(main="SKILL.md"))

    assert info.storage_root_for(folder) == folder
    assert info.body_path_for(folder) == main
    assert info.storage_root_for(main) == folder
    assert info.body_path_for(main) == main

    same_named_folder = tmp_path / "SKILL.md"
    same_named_folder.mkdir()
    assert info.storage_root_for(same_named_folder) == same_named_folder
    assert info.body_path_for(same_named_folder) == same_named_folder / "SKILL.md"


def test_declaration_carries_identity_traits_that_do_not_affect_hash() -> None:
    carrier = Derived()
    key = lambda ref: "key"  # noqa: E731
    info = TypeInfo(
        type_name="probe",
        identity_carrier=carrier,
        id_stable_key_fn=key,
        id_namespace=uuid.NAMESPACE_DNS,
    )
    assert (info.identity_carrier, info.id_stable_key_fn, info.id_namespace) == (carrier, key, uuid.NAMESPACE_DNS)
    assert info.schema_hash == TypeInfo(type_name="probe").schema_hash


def test_registry_rejects_a_conflicting_carrier() -> None:
    type_name = "_carrier_merge_probe"
    carrier = Frontmatter()
    SchemaRegistry.register(TypeInfo(type_name=type_name, identity_carrier=carrier))
    SchemaRegistry.register(TypeInfo(type_name=type_name, identity_carrier=Frontmatter()))
    assert SchemaRegistry.get(type_name).identity_carrier == carrier

    with pytest.raises(ValueError, match="Conflicting identity carrier"):
        SchemaRegistry.register(TypeInfo(type_name=type_name, identity_carrier=Derived()))
