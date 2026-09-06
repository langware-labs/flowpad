"""``reconcile`` with no owning row — pure, no DB, no indexer.

With no owner in play it is "the carrier, else mint (and write, when the
carrier is writable and the ref is not read-only)". The owner/live-ids
ordering matrix lives in ``test_reconcile_identity.py``; ``read_id`` is the
pure read the probes use.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.capsules import AssetCapsule, CapsuleData
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identity_carrier import Frontmatter, Sidecar
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import File, Folder
from tests.fixtures.identity import resolve_id

CARRIER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
OWNER = "11111111-2222-4333-8444-555555555555"
OTHER = "99999999-8888-4777-8666-555555555555"


def _info(*, stable: bool = False, folder: bool = False) -> TypeInfo:
    carrier = Sidecar() if folder else Frontmatter()
    return TypeInfo(
        type_name="probe",
        shape=Folder() if folder else File(ext=".md"),   # the seam refuses a path outside the declared shape
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
    assert resolve_id(_info(folder=folder), FSRef(path)) == CARRIER
    assert _info(folder=folder).read_id(FSRef(path)) == CARRIER


@pytest.mark.parametrize("folder", [False, True])
def test_no_carrier_and_no_owner_mints_and_persists(tmp_path: Path, folder: bool) -> None:
    path = _asset(tmp_path, folder=folder)
    minted = resolve_id(_info(folder=folder), FSRef(path))
    assert uuid.UUID(minted).version == 4
    assert _stored_id(path) == minted
    assert resolve_id(_info(folder=folder), FSRef(path)) == minted, "idempotent: the second call reads it"


def test_read_id_never_writes(tmp_path: Path) -> None:
    """The probe corner: collision ranking and create guards need "the carrier
    says X" to differ from "we would compute X"."""
    path = _asset(tmp_path)
    info = _info()
    assert info.read_id(FSRef(path)) is None
    assert _stored_id(path) is None, "a probe never writes"
    minted = resolve_id(info, FSRef(path))
    assert info.read_id(FSRef(path)) == minted


def test_minted_frontmatter_id_is_the_first_key(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("---\ntitle: Note\n---\n\nbody\n", encoding="utf-8")
    minted = resolve_id(_info(), FSRef(path))
    text = path.read_text(encoding="utf-8")
    assert text.startswith(f"---\nid: {minted}\ntitle: Note\n---")
    assert text.rstrip().endswith("body")


def test_proposed_id_is_stamped_when_the_source_is_blank(tmp_path: Path) -> None:
    fresh = tmp_path / "fresh.md"
    fresh.write_text("body\n", encoding="utf-8")
    assert _info().stamp_id(FSRef(fresh), OTHER) == OTHER
    assert _stored_id(fresh) == OTHER
    with pytest.raises(ValueError, match="UUID v4 or v5"):
        _info().stamp_id(FSRef(fresh), "018f0000-0000-7000-8000-000000000000")


def test_read_only_portable_asset_uses_path_v5_without_writing(tmp_path: Path) -> None:
    path = _asset(tmp_path)
    assert resolve_id(_info(), FSRef(path, read_only=True)) == str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    assert _stored_id(path) is None


def test_invalid_carrier_without_owner_uses_stable_v5_and_keeps_bytes(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("---\nid: 018f0000-0000-7000-8000-000000000000\n---\nbody\n", encoding="utf-8")
    before = path.read_bytes()
    assert resolve_id(_info(), FSRef(path)) == str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    assert path.read_bytes() == before


