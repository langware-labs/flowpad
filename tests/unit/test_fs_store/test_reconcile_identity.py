"""The owner/fossil ordering matrix of ``indexer.reconcile`` — pure, no DB.

    1. the carrier   IF no row owns this path
                     OR the carrier IS that row
                     OR the carrier is a live id of this type
    2. else the owning row (never for a derived type)
    3. else mint

``live_ids=None`` means "cannot prove dead", so a valid carrier still wins.
"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

import pytest

from flow_sdk.capsules import AssetCapsule, CapsuleData, CapsuleSpec
from flow_sdk.fs_store.identity_carrier import Derived, Frontmatter, JsonRoot, MalformedCarrier
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.indexer.functions._asset_identity import frontmatter_identity
from flow_sdk.fs_store.indexer.index_log import read_scan_issues
from flow_sdk.fs_store.indexer.reconcile import reconcile
from flow_sdk.fs_store.schema_registry import TypeInfo

CARRIER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
OWNER = "11111111-2222-4333-8444-555555555555"
OTHER = "99999999-8888-4777-8666-555555555555"
IDENTITY = CapsuleSpec("identity", 1)


def _info(*, stable: bool = False, carrier=None) -> TypeInfo:
    return TypeInfo(
        type_name="probe", capsules=(IDENTITY,),
        identity_carrier=carrier or Frontmatter(),
        id_stable_key_fn=(lambda ref: "stable-key") if stable else None,
    )


def _md(tmp_path: Path, text: str = "body\n", name: str = "asset.md") -> Path:
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return path


def _fm_id(path: Path) -> str | None:
    fm = _extract_frontmatter(path.read_text(encoding="utf-8"))
    return (_yaml_load(fm) or {}).get("id") if fm else None


def _run(info: TypeInfo, path: Path, owner=None, live=None, *, write: bool = True) -> str:
    return reconcile(info, info.layout_of(path), owner, live, write=write)


# Rule 1 — the carrier wins ---------------------------------------------------

def test_carrier_wins_when_it_is_the_owning_row(tmp_path: Path) -> None:
    path = _md(tmp_path, f"---\nid: {CARRIER}\n---\nbody\n")
    assert _run(_info(), path, CARRIER, {CARRIER}) == CARRIER


def test_live_carrier_wins_over_a_different_owner(tmp_path: Path) -> None:
    """Both ids are real entities — this is the adopt case, not a fork."""
    path = _md(tmp_path, f"---\nid: {CARRIER}\n---\nbody\n")
    assert _run(_info(), path, OWNER, {CARRIER, OWNER}) == CARRIER


def test_unprovable_carrier_wins_when_liveness_is_unknown(tmp_path: Path) -> None:
    path = _md(tmp_path, f"---\nid: {CARRIER}\n---\nbody\n")
    assert _run(_info(), path, OWNER, None) == CARRIER


# Rule 2 — the owning row wins -------------------------------------------------

def test_wiped_carrier_loses_to_owner_and_restamps(tmp_path: Path) -> None:
    """THE BUG: an agent rewrote the doc, wiping the carrier."""
    path = _md(tmp_path)
    assert _run(_info(), path, OWNER, {OWNER}) == OWNER
    assert _fm_id(path) == OWNER, "an absent carrier is healed in place"


def test_no_write_takes_the_owner_without_touching_bytes(tmp_path: Path) -> None:
    path = _md(tmp_path)
    before = path.read_bytes()
    assert _run(_info(), path, OWNER, {OWNER}, write=False) == OWNER
    assert path.read_bytes() == before


def test_fossil_carrier_loses_to_owner_and_is_never_rewritten(tmp_path: Path) -> None:
    """A syntactically valid id that names no entity is a fossil, not identity."""
    path = _md(tmp_path, f"---\nid: {OTHER}\n---\nbody\n")
    assert _run(_info(), path, OWNER, {OWNER}) == OWNER
    assert _fm_id(path) == OTHER


def test_foreign_carrier_loses_to_owner_and_keeps_bytes(tmp_path: Path) -> None:
    path = _md(tmp_path, "---\nid: not-a-uuid\n---\nbody\n")
    before = path.read_bytes()
    assert _run(_info(), path, OWNER, {OWNER}) == OWNER
    assert path.read_bytes() == before


def test_stable_key_type_prefers_owner_after_a_move(tmp_path: Path) -> None:
    """A path/natural-key v5 changes when the file moves — that would fork it."""
    moved = _md(tmp_path, name="renamed.md")
    info = _info(stable=True)
    assert _run(info, moved, write=False) != OWNER, "precondition: the derived key disagrees"
    assert _run(info, moved, OWNER, {OWNER}) == OWNER


def test_owner_is_a_store_fact_not_a_mint_hint(tmp_path: Path) -> None:
    path = _md(tmp_path)
    assert _run(_info(), path, OWNER, {OWNER}) == OWNER
    assert _run(_info(), path, OTHER, {OWNER, OTHER}) == OWNER, "once stamped, the live carrier is the row"


# Rule 3 — mint ------------------------------------------------------------------

def test_fresh_source_mints_and_persists(tmp_path: Path) -> None:
    path = _md(tmp_path)
    minted = _run(_info(), path)
    assert uuid.UUID(minted).version == 4 and _fm_id(path) == minted


def test_foreign_carrier_records_an_issue_and_answers_the_path_v5(tmp_path: Path) -> None:
    path = _md(tmp_path, "---\nid: 018f0000-0000-7000-8000-000000000000\n---\nbody\n")
    assert _run(_info(), path) == str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    issues = [i for i in read_scan_issues("probe") if i.path == str(path)]
    assert issues and issues[-1].kind == "foreign_id"


def test_derived_type_is_never_restamped_from_a_stale_row(tmp_path: Path) -> None:
    """Provider identity is a pure function of the source: a stale row owning a
    rotated session path must not swallow a genuinely different session."""
    path = _md(tmp_path, "{}\n", name="session.jsonl")
    info = TypeInfo(type_name="probe_derived", identity_carrier=Derived(), id_stable_key_fn=lambda ref: "provider-key")
    resolved = _run(info, path, OWNER, {OWNER})
    assert resolved == str(uuid.uuid5(uuid.NAMESPACE_URL, "provider-key"))
    assert path.read_text(encoding="utf-8") == "{}\n"


def test_json_root_restamp_preserves_sibling_keys(tmp_path: Path) -> None:
    path = _md(tmp_path, json.dumps({"kept": [1, 2], "nested": {"a": 1}}), name="probe.json")
    info = TypeInfo(type_name="probe_json", main_ext=".json", identity_carrier=JsonRoot())
    assert _run(info, path, OWNER, {OWNER}) == OWNER
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["id"] == OWNER and data["kept"] == [1, 2] and data["nested"] == {"a": 1}


def test_legacy_capsule_converts_only_when_writing(tmp_path: Path) -> None:
    path = _md(tmp_path, "---\ntitle: Note\n---\n\nbody\n")
    AssetCapsule.from_path(path).write("identity", CapsuleData(1, {"id": CARRIER}))
    info = _info(carrier=frontmatter_identity())
    assert _run(info, path, write=False) == CARRIER and "flowpad:capsule" in path.read_text(encoding="utf-8")
    assert _run(info, path, write=True) == CARRIER
    assert "flowpad:capsule" not in path.read_text(encoding="utf-8") and _fm_id(path) == CARRIER


def test_malformed_carrier_raises_even_with_an_owner(tmp_path: Path) -> None:
    path = _md(tmp_path, "<!-- flowpad:capsule identity\nversion: [\nflowpad:endcapsule identity -->\n")
    with pytest.raises(MalformedCarrier):
        _run(_info(carrier=frontmatter_identity()), path, OWNER, {OWNER})


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores the read-only bit")
def test_restamp_write_failure_still_returns_the_owner(tmp_path: Path) -> None:
    """A failed heal degrades to DB-correct, never back to minting a fork."""
    d = tmp_path / "ro"
    d.mkdir()
    path = _md(d)
    os.chmod(d, 0o555)
    try:
        assert _run(_info(), path, OWNER, {OWNER}) == OWNER
    finally:
        os.chmod(d, 0o755)
