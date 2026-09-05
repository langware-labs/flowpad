"""The compat adapter ``TypeInfo.mint_entity_id`` — pure, no DB, no indexer.

With no owner in play it is "the carrier, else mint (and write, when the
carrier is writable and the ref is not read-only)". The owner/live-ids
ordering matrix lives in ``test_reconcile_identity.py``; ``read_id`` is the
pure read the probes use.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.capsules import AssetCapsule, CapsuleData, CapsuleSpec
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identity_carrier import Frontmatter, MalformedCarrier, Sidecar
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.indexer.functions._asset_identity import frontmatter_identity
from flow_sdk.fs_store.schema_registry import TypeInfo

CARRIER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
OWNER = "11111111-2222-4333-8444-555555555555"
OTHER = "99999999-8888-4777-8666-555555555555"
IDENTITY = CapsuleSpec("identity", 1)


def _info(*, stable: bool = False, folder: bool = False, legacy=()) -> TypeInfo:
    carrier = Sidecar(legacy=tuple(legacy)) if folder else Frontmatter(legacy=tuple(legacy))
    return TypeInfo(
        type_name="probe",
        capsules=(IDENTITY,),
        # A type declares the shape it claims; the seam refuses a path outside
        # it (FLOWPAD-2083). A folder-json probe therefore says it is a folder.
        main_layout="folder" if folder else "file",
        identity_carrier=carrier,
        id_stable_key_fn=(lambda ref: "stable-key") if stable else None,
    )


def _asset(tmp_path: Path, *, carrier: str | None = None, folder: bool = False) -> Path:
    path = tmp_path / ("asset" if folder else "asset.md")
    if folder:
        path.mkdir()
        if carrier:
            AssetCapsule.from_path(path).write("identity", CapsuleData(1, {"id": carrier}))
    else:
        path.write_text((f"---\nid: {carrier}\n---\n\n" if carrier else "") + "body\n", encoding="utf-8")
    return path


def _stored_id(path: Path) -> str | None:
    if path.is_dir():
        data = AssetCapsule.from_path(path).read("identity")
        return data.data.get("id") if data else None
    fm = _extract_frontmatter(path.read_text(encoding="utf-8"))
    return (_yaml_load(fm) or {}).get("id") if fm else None


@pytest.mark.parametrize("folder", [False, True])
def test_carrier_wins_when_no_row_owns_the_path(tmp_path: Path, folder: bool) -> None:
    """A clone/copy lands at an unowned path — identity travels with the file."""
    path = _asset(tmp_path, carrier=CARRIER, folder=folder)
    assert _info(folder=folder).mint_entity_id(FSRef(path)) == CARRIER
    assert _info(folder=folder).read_id(FSRef(path)) == CARRIER


@pytest.mark.parametrize("folder", [False, True])
def test_no_carrier_and_no_owner_mints_and_persists(tmp_path: Path, folder: bool) -> None:
    path = _asset(tmp_path, folder=folder)
    minted = _info(folder=folder).mint_entity_id(FSRef(path))
    assert uuid.UUID(minted).version == 4
    assert _stored_id(path) == minted
    assert _info(folder=folder).mint_entity_id(FSRef(path)) == minted, "idempotent: the second call reads it"


def test_read_id_never_writes(tmp_path: Path) -> None:
    """The probe corner: collision ranking and create guards need "the carrier
    says X" to differ from "we would compute X"."""
    path = _asset(tmp_path)
    info = _info()
    assert info.read_id(FSRef(path)) is None
    assert _stored_id(path) is None, "a probe never writes"
    minted = info.mint_entity_id(FSRef(path))
    assert info.read_id(FSRef(path)) == minted


def test_minted_frontmatter_id_is_the_first_key(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("---\ntitle: Note\n---\n\nbody\n", encoding="utf-8")
    minted = _info().mint_entity_id(FSRef(path))
    text = path.read_text(encoding="utf-8")
    assert text.startswith(f"---\nid: {minted}\ntitle: Note\n---")
    assert text.rstrip().endswith("body")


def test_proposed_id_is_stamped_when_the_source_is_blank(tmp_path: Path) -> None:
    fresh = tmp_path / "fresh.md"
    fresh.write_text("body\n", encoding="utf-8")
    assert _info().mint_entity_id(FSRef(fresh), proposed_id=OTHER) == OTHER
    assert _stored_id(fresh) == OTHER
    with pytest.raises(ValueError, match="UUID v4 or v5"):
        _info().mint_entity_id(FSRef(fresh), proposed_id="018f0000-0000-7000-8000-000000000000")


def test_read_only_portable_asset_uses_path_v5_without_writing(tmp_path: Path) -> None:
    path = _asset(tmp_path)
    assert _info().mint_entity_id(FSRef(path, read_only=True)) == str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    assert _stored_id(path) is None


def test_invalid_carrier_without_owner_uses_stable_v5_and_keeps_bytes(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("---\nid: 018f0000-0000-7000-8000-000000000000\n---\nbody\n", encoding="utf-8")
    before = path.read_bytes()
    assert _info().mint_entity_id(FSRef(path)) == str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    assert path.read_bytes() == before


# --------------------------------------------------------------------------
# Legacy markdown capsule → converted in place
# --------------------------------------------------------------------------

def test_legacy_capsule_is_converted_into_frontmatter(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("---\ntitle: Note\n---\n\nbody\n", encoding="utf-8")
    AssetCapsule.from_path(path).write("identity", CapsuleData(1, {"id": CARRIER}))
    info = frontmatter_identity_info()

    assert info.read_id(FSRef(path)) == CARRIER, "read sees the legacy capsule"
    assert info.mint_entity_id(FSRef(path)) == CARRIER
    text = path.read_text(encoding="utf-8")
    assert "flowpad:capsule" not in text
    assert text.startswith(f"---\nid: {CARRIER}\ntitle: Note\n---")
    assert info.mint_entity_id(FSRef(path)) == CARRIER and "flowpad:capsule" not in path.read_text(encoding="utf-8")


def test_legacy_capsule_on_a_read_only_ref_is_read_but_untouched(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body\n", encoding="utf-8")
    AssetCapsule.from_path(path).write("identity", CapsuleData(1, {"id": CARRIER}))
    before = path.read_bytes()
    assert frontmatter_identity_info().mint_entity_id(FSRef(path, read_only=True)) == CARRIER
    assert path.read_bytes() == before


def test_frontmatter_id_beats_a_disagreeing_legacy_capsule(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text(f"---\nid: {CARRIER}\n---\n\nbody\n", encoding="utf-8")
    AssetCapsule.from_path(path).write("identity", CapsuleData(1, {"id": OTHER}))
    assert frontmatter_identity_info().mint_entity_id(FSRef(path)) == CARRIER
    assert _stored_id(path) == CARRIER


def frontmatter_identity_info() -> TypeInfo:
    return TypeInfo(type_name="probe", capsules=(IDENTITY,), identity_carrier=frontmatter_identity())


def test_malformed_carrier_raises(tmp_path: Path) -> None:
    """A corrupt source must not be silently re-identified."""
    path = tmp_path / "asset.md"
    path.write_text("<!-- flowpad:capsule identity\nversion: [\nflowpad:endcapsule identity -->\n", encoding="utf-8")
    with pytest.raises(MalformedCarrier):
        frontmatter_identity_info().mint_entity_id(FSRef(path))
