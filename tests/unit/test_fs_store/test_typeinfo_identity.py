"""Fast matrix for TypeInfo's storage-neutral identity policy."""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.capsules import AssetCapsule, CapsuleData, CapsuleSpec, MalformedCapsuleError
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identity_backend import CapsuleIdentityBackend, DerivedIdentityBackend
from flow_sdk.fs_store.indexer._frontmatter import read_frontmatter_id
from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo
from flow_sdk.schema.type_info import TypeMetadata

V4 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
V5 = str(uuid.uuid5(uuid.NAMESPACE_URL, "existing"))
V7 = "018f0000-0000-7000-8000-000000000000"
IDENTITY = CapsuleSpec("identity", 1)


def _capsule_info(*, stable: bool = False, legacy=()) -> TypeInfo:
    return TypeInfo(
        type_name="probe",
        capsules=(IDENTITY,),
        identity_backend=CapsuleIdentityBackend(legacy_readers=tuple(legacy)),
        id_stable_key_fn=(lambda ref: "stable-key") if stable else None,
    )


@pytest.mark.parametrize("existing", [V4, V5])
@pytest.mark.parametrize("folder", [False, True])
def test_extract_and_mint_adopt_canonical_file_or_folder(
    tmp_path: Path, existing: str, folder: bool
) -> None:
    path = tmp_path / ("asset" if folder else "asset.md")
    path.mkdir() if folder else path.write_text("body\n", encoding="utf-8")
    AssetCapsule.from_path(path).write("identity", CapsuleData(1, {"id": existing}))
    info = _capsule_info()

    assert info.mint_entity_id(FSRef(path)) == existing
    assert info.mint_entity_id(FSRef(path), proposed_id=V5, derive=True, overwrite=True) == existing


@pytest.mark.parametrize("folder", [False, True])
def test_absent_portable_identity_persists_one_v4(tmp_path: Path, folder: bool) -> None:
    path = tmp_path / ("asset" if folder else "asset.md")
    path.mkdir() if folder else path.write_text("body\n", encoding="utf-8")
    info = _capsule_info()

    first = info.mint_entity_id(FSRef(path), derive=True, overwrite=True)
    assert uuid.UUID(first).version == 4
    assert info.mint_entity_id(FSRef(path), derive=True, overwrite=True) == first
    assert AssetCapsule.from_path(path).read("identity") == CapsuleData(1, {"id": first})


def test_stable_policy_persists_v5_in_capsule(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body\n", encoding="utf-8")
    info = _capsule_info(stable=True)

    expected = str(uuid.uuid5(uuid.NAMESPACE_URL, "stable-key"))
    assert info.mint_entity_id(path, derive=True, overwrite=True) == expected
    assert info.mint_entity_id(path) == expected


def test_valid_legacy_id_is_adopted_without_backfill(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text(f"---\nid: {V4}\n---\nbody\n", encoding="utf-8")
    info = _capsule_info(legacy=(read_frontmatter_id,))

    assert info.mint_entity_id(path) == V4
    assert info.mint_entity_id(path, derive=True, overwrite=True) == V4
    assert AssetCapsule.from_path(path).read("identity") is None


def test_invalid_canonical_uses_valid_legacy_without_rewrite(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text(f"---\nid: {V4}\n---\nbody\n", encoding="utf-8")
    capsule = AssetCapsule.from_path(path)
    capsule.write("identity", CapsuleData(1, {"id": V7}))
    before = path.read_bytes()
    info = _capsule_info(legacy=(read_frontmatter_id,))

    assert info.mint_entity_id(path, derive=True, overwrite=True) == V4
    assert path.read_bytes() == before


@pytest.mark.parametrize("candidate", ["garbage", V7])
def test_invalid_canonical_without_legacy_uses_path_v5_and_preserves_bytes(
    tmp_path: Path, candidate: str
) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body\n", encoding="utf-8")
    AssetCapsule.from_path(path).write("identity", CapsuleData(1, {"id": candidate}))
    before = path.read_bytes()

    expected = str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    assert _capsule_info().mint_entity_id(path, derive=True, overwrite=True) == expected
    assert path.read_bytes() == before


def test_invalid_legacy_is_distinct_from_absence_and_uses_stable_v5(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("---\nid: invalid\n---\nbody\n", encoding="utf-8")
    before = path.read_bytes()
    info = _capsule_info(legacy=(lambda candidate: "invalid",))

    assert info.mint_entity_id(path, derive=True, overwrite=True) == str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    assert AssetCapsule.from_path(path).read("identity") is None
    assert path.read_bytes() == before


def test_read_only_portable_asset_uses_path_v5_without_writing(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body\n", encoding="utf-8")
    ref = FSRef(path, read_only=True)

    assert _capsule_info().mint_entity_id(ref, derive=True, overwrite=True) == str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    assert AssetCapsule.from_path(path).read("identity") is None


def test_proposed_id_is_persisted_but_filesystem_winner_wins(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body\n", encoding="utf-8")
    info = _capsule_info()

    assert info.mint_entity_id(path, proposed_id=V4, derive=True, overwrite=True) == V4
    assert info.mint_entity_id(path, proposed_id=V5, derive=True, overwrite=True) == V4
    with pytest.raises(ValueError, match="UUID v4 or v5"):
        info.mint_entity_id(path, proposed_id=V7, derive=True, overwrite=True)


def test_proposed_id_preserves_source_less_stable_type_identity(tmp_path: Path) -> None:
    path = tmp_path / "spec.md"
    path.write_text("body\n", encoding="utf-8")
    info = _capsule_info(stable=True)

    assert info.mint_entity_id(path, proposed_id=V4, derive=True, overwrite=True) == V4
    assert info.mint_entity_id(path) == V4


def test_malformed_capsule_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text(
        "<!-- flowpad:capsule identity\nversion: [\nflowpad:endcapsule identity -->\n",
        encoding="utf-8",
    )
    with pytest.raises(MalformedCapsuleError):
        _capsule_info().mint_entity_id(path, derive=True, overwrite=True)


@pytest.mark.parametrize("payload", [{}, {"id": V4, "extra": True}])
def test_non_identity_capsule_shape_is_malformed(tmp_path: Path, payload: dict) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body\n", encoding="utf-8")
    AssetCapsule.from_path(path).write("identity", CapsuleData(1, payload))

    with pytest.raises(MalformedCapsuleError, match="exactly the 'id' key"):
        _capsule_info().mint_entity_id(path)


def test_folder_main_file_normalizes_to_owning_capsule(tmp_path: Path) -> None:
    folder = tmp_path / "skill"
    folder.mkdir()
    main = folder / "SKILL.md"
    main.write_text("body\n", encoding="utf-8")
    info = TypeInfo(
        type_name="probe",
        main_layout="folder",
        main_file="SKILL.md",
        capsules=(IDENTITY,),
        identity_backend=CapsuleIdentityBackend(),
    )

    assert info.capsule_target_for(FSRef(main)) == folder
    minted = info.mint_entity_id(FSRef(main), derive=True, overwrite=True)
    assert AssetCapsule.from_path(folder).read("identity") == CapsuleData(1, {"id": minted})


def test_folder_backed_main_file_ref_normalizes_idempotently(tmp_path: Path) -> None:
    folder = tmp_path / "skill"
    folder.mkdir()
    main = folder / "SKILL.md"
    main.write_text("body\n", encoding="utf-8")
    info = TypeInfo(
        type_name="probe",
        main_layout="folder",
        main_file="SKILL.md",
    )

    assert info.storage_root_for(folder) == folder
    assert info.body_path_for(folder) == main
    assert info.storage_root_for(main) == folder
    assert info.body_path_for(main) == main

    same_named_folder = tmp_path / "SKILL.md"
    same_named_folder.mkdir()
    assert info.storage_root_for(same_named_folder) == same_named_folder
    assert info.body_path_for(same_named_folder) == same_named_folder / "SKILL.md"


def test_metadata_carries_identity_traits_and_capsules_affect_hash() -> None:
    backend = DerivedIdentityBackend()
    key = lambda ref: "key"  # noqa: E731
    info = TypeMetadata(
        type="probe",
        capsules=(IDENTITY,),
        identity_backend=backend,
        id_stable_key_fn=key,
        id_namespace=uuid.NAMESPACE_DNS,
    ).to_type_info()

    assert (info.capsules, info.identity_backend, info.id_stable_key_fn, info.id_namespace) == (
        (IDENTITY,), backend, key, uuid.NAMESPACE_DNS,
    )
    assert info.schema_hash != TypeInfo(type_name="probe").schema_hash


def test_registry_merges_capsules_and_rejects_same_name_conflict() -> None:
    type_name = "_capsule_merge_probe"
    backend = CapsuleIdentityBackend()
    SchemaRegistry.register(
        TypeInfo(type_name=type_name, capsules=(IDENTITY,), identity_backend=backend)
    )
    SchemaRegistry.register(TypeInfo(type_name=type_name, capsules=(IDENTITY, CapsuleSpec("review", 1))))
    assert SchemaRegistry.get(type_name).capsules == (IDENTITY, CapsuleSpec("review", 1))

    with pytest.raises(ValueError, match="Conflicting capsule"):
        SchemaRegistry.register(TypeInfo(type_name=type_name, capsules=(CapsuleSpec("identity", 2),)))

    with pytest.raises(ValueError, match="Conflicting identity backend"):
        SchemaRegistry.register(
            TypeInfo(type_name=type_name, identity_backend=DerivedIdentityBackend())
        )
