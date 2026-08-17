"""The ordering matrix for ``TypeInfo.resolve_id`` — pure, no DB, no indexer.

An asset's id lives in the source, but a full-content rewrite wipes that
carrier. Resolving from the source alone then invents a new id for a path a row
already owns. ``resolve_id`` decides between the carrier and the owning row, and
the axis is CARRIER LIVENESS, not "file vs database":

    1. the carrier   IF no row owns this path
                     OR the carrier IS that row
                     OR the carrier is a live id of this type
    2. else the owning row
    3. else mint

``live_ids=None`` means "cannot prove dead", so a valid carrier still wins —
only a caller holding the complete per-type id set (the index walk) may conclude
that a carrier names no entity.
"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

import pytest

from flow_sdk.capsules import AssetCapsule, CapsuleData, CapsuleSpec, MalformedCapsuleError
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identity_backend import (
    CapsuleIdentityBackend,
    DerivedIdentityBackend,
    NativeJsonIdentityBackend,
)
from flow_sdk.fs_store.schema_registry import TypeInfo

CARRIER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
OWNER = "11111111-2222-4333-8444-555555555555"
OTHER = "99999999-8888-4777-8666-555555555555"
IDENTITY = CapsuleSpec("identity", 1)


def _info(*, stable: bool = False, legacy=()) -> TypeInfo:
    return TypeInfo(
        type_name="probe",
        capsules=(IDENTITY,),
        identity_backend=CapsuleIdentityBackend(legacy_readers=tuple(legacy)),
        id_stable_key_fn=(lambda ref: "stable-key") if stable else None,
    )


def _asset(tmp_path: Path, *, carrier: str | None = None, folder: bool = False) -> Path:
    path = tmp_path / ("asset" if folder else "asset.md")
    path.mkdir() if folder else path.write_text("body\n", encoding="utf-8")
    if carrier:
        AssetCapsule.from_path(path).write("identity", CapsuleData(1, {"id": carrier}))
    return path


def _capsule_id(path: Path) -> str | None:
    data = AssetCapsule.from_path(path).read("identity")
    return data.data.get("id") if data else None


# --------------------------------------------------------------------------
# Rule 1 — the carrier wins
# --------------------------------------------------------------------------

@pytest.mark.parametrize("folder", [False, True])
def test_carrier_wins_when_no_row_owns_the_path(tmp_path: Path, folder: bool) -> None:
    """A clone/copy lands at an unowned path — identity travels with the file."""
    path = _asset(tmp_path, carrier=CARRIER, folder=folder)
    assert _info().mint_entity_id(FSRef(path)) == CARRIER


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
    """THE BUG: an agent rewrote the doc, wiping the capsule."""
    path = _asset(tmp_path)
    info = _info()

    assert info.mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={OWNER}, overwrite=True) == OWNER
    assert _capsule_id(path) == OWNER, "an absent carrier is healed in place"


def test_absent_carrier_loses_to_owner_without_restamp(tmp_path: Path) -> None:
    path = _asset(tmp_path)
    assert _info().mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={OWNER}) == OWNER
    assert _capsule_id(path) is None, "overwrite=False never writes"


def test_dead_carrier_loses_to_owner(tmp_path: Path) -> None:
    """A syntactically valid id that names no entity is a fossil, not identity."""
    path = _asset(tmp_path, carrier=OTHER)
    assert _info().mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={OWNER}) == OWNER


def test_invalid_carrier_loses_to_owner_without_rewriting_bytes(tmp_path: Path) -> None:
    """INVALID is not ABSENT — user bytes are never clobbered."""
    path = tmp_path / "asset.md"
    path.write_text("---\nid: not-a-uuid\n---\nbody\n", encoding="utf-8")
    before = path.read_bytes()
    info = _info(legacy=(lambda p: "not-a-uuid",))

    assert info.mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={OWNER}, overwrite=True) == OWNER
    assert path.read_bytes() == before


def test_stable_key_type_prefers_owner_after_a_move(tmp_path: Path) -> None:
    """A path/natural-key v5 changes when the file moves — that would fork it."""
    moved = tmp_path / "renamed.md"
    moved.write_text("body\n", encoding="utf-8")
    info = _info(stable=True)

    would_mint = info.mint_entity_id(FSRef(moved), derive=True, overwrite=True)
    assert would_mint != OWNER, "precondition: the derived key disagrees with the row"
    assert info.mint_entity_id(FSRef(moved), owner_id=OWNER, live_ids={OWNER}) == OWNER


# --------------------------------------------------------------------------
# Rule 3 — mint, and the degenerate (DB-free) contract
# --------------------------------------------------------------------------

def test_no_carrier_and_no_owner_mints_and_persists(tmp_path: Path) -> None:
    path = _asset(tmp_path)
    minted = _info().mint_entity_id(FSRef(path), derive=True, overwrite=True)
    assert uuid.UUID(minted).version == 4
    assert _capsule_id(path) == minted


def test_probe_mode_returns_none_when_evidence_is_exhausted(tmp_path: Path) -> None:
    """The default corner: no carrier, no owner, no derive ⇒ a truthful None.

    This is what the collision-identity and create-guard callers rely on — a
    derived value there would make two unstamped copies look identical.
    """
    path = _asset(tmp_path)
    info = _info()
    assert info.mint_entity_id(FSRef(path)) is None
    assert _capsule_id(path) is None, "a probe never writes"
    # …and once it derives, the answer is stable and committed.
    minted = info.mint_entity_id(FSRef(path), derive=True, overwrite=True)
    assert info.mint_entity_id(FSRef(path)) == minted, "the probe now sees the carrier"


def test_proposed_id_only_reaches_the_mint_branch(tmp_path: Path) -> None:
    """owner_id is a fact in the store; proposed_id is only a mint hint."""
    owned = _asset(tmp_path)
    assert _info().mint_entity_id(FSRef(owned), owner_id=OWNER, live_ids={OWNER}, proposed_id=OTHER) == OWNER

    fresh = tmp_path / "fresh.md"
    fresh.write_text("body\n", encoding="utf-8")
    assert _info().mint_entity_id(
        FSRef(fresh), proposed_id=OTHER, derive=True, overwrite=True
    ) == OTHER


# --------------------------------------------------------------------------
# Type flavors that must NOT take an owner id
# --------------------------------------------------------------------------

def test_derived_type_ignores_owner_id(tmp_path: Path) -> None:
    """Provider identity is a pure function of the source.

    A stale row owning a rotated session path must not swallow a genuinely
    different session, so rule 2 is gated on a persisting backend.
    """
    path = tmp_path / "session.jsonl"
    path.write_text("{}\n", encoding="utf-8")
    info = TypeInfo(
        type_name="probe_derived",
        identity_backend=DerivedIdentityBackend(reader=lambda p: None),
        id_stable_key_fn=lambda ref: "provider-key",
    )
    resolved = info.mint_entity_id(
        FSRef(path), owner_id=OWNER, live_ids={OWNER}, derive=True, overwrite=True
    )
    assert resolved != OWNER
    assert resolved == str(uuid.uuid5(uuid.NAMESPACE_URL, "provider-key"))


def test_read_only_ref_takes_the_owner_without_writing(tmp_path: Path) -> None:
    path = _asset(tmp_path)
    before = path.read_bytes()
    resolved = _info().mint_entity_id(FSRef(path, read_only=True), owner_id=OWNER, live_ids={OWNER}, overwrite=True)
    assert resolved == OWNER
    assert path.read_bytes() == before


def test_native_json_restamp_preserves_sibling_keys(tmp_path: Path) -> None:
    path = tmp_path / "report.json"
    path.write_text(json.dumps({"kept": [1, 2], "nested": {"a": 1}}), encoding="utf-8")
    info = TypeInfo(type_name="probe_json", identity_backend=NativeJsonIdentityBackend())

    assert info.mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={OWNER}, overwrite=True) == OWNER
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["id"] == OWNER
    assert data["kept"] == [1, 2] and data["nested"] == {"a": 1}


# --------------------------------------------------------------------------
# Fail-closed
# --------------------------------------------------------------------------

def test_malformed_carrier_raises_even_with_an_owner(tmp_path: Path) -> None:
    """A corrupt source must not be silently re-identified onto a live row."""
    path = tmp_path / "asset.md"
    path.write_text(
        "<!-- flowpad:capsule identity\nversion: [\nflowpad:endcapsule identity -->\n",
        encoding="utf-8",
    )
    with pytest.raises(MalformedCapsuleError):
        _info().mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={OWNER})


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores the read-only bit")
def test_restamp_write_failure_still_returns_the_owner(tmp_path: Path) -> None:
    """A failed heal degrades to DB-correct, never back to minting a fork."""
    d = tmp_path / "ro"
    d.mkdir()
    path = d / "asset.md"
    path.write_text("body\n", encoding="utf-8")
    os.chmod(d, 0o555)
    try:
        assert _info().mint_entity_id(FSRef(path), owner_id=OWNER, live_ids={OWNER}, overwrite=True) == OWNER
    finally:
        os.chmod(d, 0o755)
