"""The ordering matrix for ``TypeInfo.mint_entity_id`` — pure, no DB, no indexer.

An asset's id lives in the source, but a full-content rewrite wipes that
carrier. Resolving from the source alone then invents a new id for a path a row
already owns. The seam decides between the carrier and the owning row, and the
axis is CARRIER LIVENESS, not "file vs database":

    1. the carrier   IF no row owns this path
                     OR the carrier IS that row
                     OR the carrier is a live id of this type
    2. else the owning row
    3. else mint (and write, when the carrier is writable and the ref is not read-only)

``live_ids=None`` means "cannot prove dead", so a valid carrier still wins —
only a caller holding the complete per-type id set (the index walk) may conclude
that a carrier names no entity. ``read_id`` is the pure read the probes use.
"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

import pytest

from flow_sdk.capsules import AssetCapsule, CapsuleData, CapsuleSpec
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identity_carrier import (
    DerivedCarrier,
    FolderJsonCarrier,
    FrontmatterCarrier,
    MalformedCarrier,
    NativeJsonCarrier,
)
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.indexer.functions._asset_identity import frontmatter_identity
from flow_sdk.fs_store.schema_registry import TypeInfo

CARRIER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
OWNER = "11111111-2222-4333-8444-555555555555"
OTHER = "99999999-8888-4777-8666-555555555555"
IDENTITY = CapsuleSpec("identity", 1)


def _info(*, stable: bool = False, folder: bool = False, legacy=()) -> TypeInfo:
    carrier = FolderJsonCarrier(legacy=tuple(legacy)) if folder else FrontmatterCarrier(legacy=tuple(legacy))
    return TypeInfo(
        type_name="probe",
        capsules=(IDENTITY,),
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


# --------------------------------------------------------------------------
# Rule 1 — the carrier wins
# --------------------------------------------------------------------------

@pytest.mark.parametrize("folder", [False, True])
def test_carrier_wins_when_no_row_owns_the_path(tmp_path: Path, folder: bool) -> None:
    """A clone/copy lands at an unowned path — identity travels with the file."""
    path = _asset(tmp_path, carrier=CARRIER, folder=folder)
    assert _info(folder=folder).mint_entity_id(FSRef(path)) == CARRIER
    assert _info(folder=folder).read_id(FSRef(path)) == CARRIER


def test_carrier_wins_when_it_is_the_owning_row(tmp_path: Path) -> None:
    path = _asset(tmp_path, carrier=CARRIER)
    assert _info().mint_entity_id(FSRef(path), owner_id=CARRIER, live_ids={CARRIER}) == CARRIER


def test_live_carrier_wins_over_a_different_owner(tmp_path: Path) -> None:
    """Both ids are real entities — this is the adopt case, not a fork."""
    path = _asset(tmp_path, carrier=CARRIER)
    assert _info().mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={CARRIER, OWNER}) == CARRIER


def test_unprovable_carrier_wins_when_liveness_is_unknown(tmp_path: Path) -> None:
    """Without a liveness oracle a caller may not declare a carrier dead."""
    path = _asset(tmp_path, carrier=CARRIER)
    assert _info().mint_entity_id(FSRef(path), owner_id=OWNER, live_ids=None) == CARRIER


# --------------------------------------------------------------------------
# Rule 2 — the owning row wins
# --------------------------------------------------------------------------

def test_absent_carrier_loses_to_owner_and_restamps(tmp_path: Path) -> None:
    """THE BUG: an agent rewrote the doc, wiping the carrier."""
    path = _asset(tmp_path)
    assert _info().mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={OWNER}) == OWNER
    assert _stored_id(path) == OWNER, "an absent carrier is healed in place"


def test_read_only_ref_takes_the_owner_without_writing(tmp_path: Path) -> None:
    path = _asset(tmp_path)
    before = path.read_bytes()
    assert _info().mint_entity_id(FSRef(path, read_only=True), owner_id=OWNER, live_ids={OWNER}) == OWNER
    assert path.read_bytes() == before


def test_dead_carrier_loses_to_owner(tmp_path: Path) -> None:
    """A syntactically valid id that names no entity is a fossil, not identity."""
    path = _asset(tmp_path, carrier=OTHER)
    assert _info().mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={OWNER}) == OWNER
    assert _stored_id(path) == OTHER, "a present carrier is never rewritten"


def test_invalid_carrier_loses_to_owner_without_rewriting_bytes(tmp_path: Path) -> None:
    """INVALID is not ABSENT — user bytes are never clobbered."""
    path = tmp_path / "asset.md"
    path.write_text("---\nid: not-a-uuid\n---\nbody\n", encoding="utf-8")
    before = path.read_bytes()
    assert _info().mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={OWNER}) == OWNER
    assert path.read_bytes() == before


def test_stable_key_type_prefers_owner_after_a_move(tmp_path: Path) -> None:
    """A path/natural-key v5 changes when the file moves — that would fork it."""
    moved = tmp_path / "renamed.md"
    moved.write_text("body\n", encoding="utf-8")
    info = _info(stable=True)
    assert info.mint_entity_id(FSRef(moved, read_only=True)) != OWNER, "precondition: the derived key disagrees"
    assert info.mint_entity_id(FSRef(moved), owner_id=OWNER, live_ids={OWNER}) == OWNER


# --------------------------------------------------------------------------
# Rule 3 — mint, and the degenerate (DB-free) contract
# --------------------------------------------------------------------------

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


def test_proposed_id_only_reaches_the_mint_branch(tmp_path: Path) -> None:
    """owner_id is a fact in the store; proposed_id is only a mint hint."""
    owned = _asset(tmp_path)
    assert _info().mint_entity_id(FSRef(owned), owner_id=OWNER, live_ids={OWNER}, proposed_id=OTHER) == OWNER
    fresh = tmp_path / "fresh.md"
    fresh.write_text("body\n", encoding="utf-8")
    assert _info().mint_entity_id(FSRef(fresh), proposed_id=OTHER) == OTHER
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


# --------------------------------------------------------------------------
# Type flavors that must NOT take an owner id
# --------------------------------------------------------------------------

def test_derived_type_ignores_owner_id(tmp_path: Path) -> None:
    """Provider identity is a pure function of the source: a stale row owning a
    rotated session path must not swallow a genuinely different session."""
    path = tmp_path / "session.jsonl"
    path.write_text("{}\n", encoding="utf-8")
    info = TypeInfo(
        type_name="probe_derived",
        identity_carrier=DerivedCarrier(reader=lambda p: None),
        id_stable_key_fn=lambda ref: "provider-key",
    )
    resolved = info.mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={OWNER})
    assert resolved != OWNER
    assert resolved == str(uuid.uuid5(uuid.NAMESPACE_URL, "provider-key"))


def test_native_json_restamp_preserves_sibling_keys(tmp_path: Path) -> None:
    path = tmp_path / "report.json"
    path.write_text(json.dumps({"kept": [1, 2], "nested": {"a": 1}}), encoding="utf-8")
    info = TypeInfo(type_name="probe_json", identity_carrier=NativeJsonCarrier())

    assert info.mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={OWNER}) == OWNER
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["id"] == OWNER
    assert data["kept"] == [1, 2] and data["nested"] == {"a": 1}


# --------------------------------------------------------------------------
# Fail-closed
# --------------------------------------------------------------------------

def test_malformed_carrier_raises_even_with_an_owner(tmp_path: Path) -> None:
    """A corrupt source must not be silently re-identified onto a live row."""
    path = tmp_path / "asset.md"
    path.write_text("<!-- flowpad:capsule identity\nversion: [\nflowpad:endcapsule identity -->\n", encoding="utf-8")
    with pytest.raises(MalformedCarrier):
        frontmatter_identity_info().mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={OWNER})


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores the read-only bit")
def test_restamp_write_failure_still_returns_the_owner(tmp_path: Path) -> None:
    """A failed heal degrades to DB-correct, never back to minting a fork."""
    d = tmp_path / "ro"
    d.mkdir()
    path = d / "asset.md"
    path.write_text("body\n", encoding="utf-8")
    os.chmod(d, 0o555)
    try:
        assert _info().mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={OWNER}) == OWNER
    finally:
        os.chmod(d, 0o755)
