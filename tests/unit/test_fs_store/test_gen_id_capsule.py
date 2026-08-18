"""Capsule-v4 per-type ``TypeInfo.mint_id`` coverage.

For every shareable type: adopt a valid v4/v5 legacy id, else mint a fresh v4
and write it through ``AssetCapsule`` — never
persist uuid5(name/path). Plus the two type-specific regressions: agent must
write the UUID (not the name) into ``id:``; folder types persist their capsule.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.capsules import AssetCapsule
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.indexer.functions._folder_capsule import read_folder_capsule_id
from flow_sdk.fs_store.schema_registry import SchemaRegistry

V4 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
V7 = "018f0000-0000-7000-8000-000000000000"


def _ver(u: str) -> int:
    return uuid.UUID(u).version


def _frontmatter_id(md: Path):
    fm = _extract_frontmatter(md.read_text(encoding="utf-8"))
    return (_yaml_load(fm) or {}).get("id") if fm else None


def _capsule_id(ref: FSRef):
    data = AssetCapsule.from_path(ref._path).read("identity")
    return data.data.get("id") if data else None


# ── per-type harness ─────────────────────────────────────────────────────────
# Each spec: build(dir, id) -> ref ; gen(ref) -> id ; capsule(ref) -> stored id ;
# legacy(ref) -> the old uuid5(name/path) value (must NOT be the minted id).

def _agent(d: Path, fm_id: str | None):
    p = d / "a.md"
    idline = f"id: {fm_id}\n" if fm_id else ""
    p.write_text(f"---\n{idline}name: My Agent\n---\n\nprompt", encoding="utf-8")
    return FSRef(p)


def _whiteboard(d: Path, cap_id: str | None):
    wb = d / "board"
    wb.mkdir()
    (wb / "WHITE_BOARD.md").write_text("---\nname: Board\n---\n\nx", encoding="utf-8")
    if cap_id:
        (wb / ".flow").mkdir()
        (wb / ".flow" / "id").write_text(cap_id, encoding="utf-8")
    return FSRef(wb)


def _task(d: Path, cap_id: str | None):
    tk = d / "My Task"
    tk.mkdir()
    (tk / "task.md").write_text("---\ntitle: T\n---\n\nbody", encoding="utf-8")
    if cap_id:
        (tk / ".flow").mkdir()
        (tk / ".flow" / "id").write_text(cap_id, encoding="utf-8")
    return FSRef(tk)


def _dataset(d: Path, cap_id: str | None):
    ds = d / "ds"
    ds.mkdir()
    (ds / "dataset.json").write_text('{"metadata": {}}', encoding="utf-8")
    if cap_id:
        (ds / ".flow").mkdir()
        (ds / ".flow" / "id").write_text(cap_id, encoding="utf-8")
    return FSRef(ds)


def _mint(type_name: str, ref: FSRef) -> str:
    info = SchemaRegistry.get(type_name)
    assert info is not None
    return info.mint_entity_id(ref, derive=True, overwrite=True)


SPECS = {
    "subagent": (_agent, lambda r: _mint("subagent", r), _capsule_id, None),
    "whiteboard": (_whiteboard, lambda r: _mint("whiteboard", r), _capsule_id, None),
    "task": (_task, lambda r: _mint("task", r), _capsule_id, None),
    "dataset": (_dataset, lambda r: _mint("dataset", r), _capsule_id, None),
}
TYPES = list(SPECS)


@pytest.mark.parametrize("t", TYPES)
def test_valid_v4_capsule_adopted(tmp_path: Path, t: str) -> None:
    build, gen, capsule, _ = SPECS[t]
    ref = build(tmp_path, V4)
    assert gen(ref) == V4


@pytest.mark.parametrize("t", TYPES)
def test_foreign_id_rejected_uses_stable_v5_without_rewrite(tmp_path: Path, t: str) -> None:
    build, gen, capsule, _ = SPECS[t]
    ref = build(tmp_path, V7)
    got = gen(ref)
    expected = str(uuid.uuid5(uuid.NAMESPACE_URL, str(ref._path.resolve())))
    assert got == expected
    assert capsule(ref) is None


@pytest.mark.parametrize("t", TYPES)
def test_no_id_mints_v4_persists_and_idempotent(tmp_path: Path, t: str) -> None:
    build, gen, capsule, legacy = SPECS[t]
    ref = build(tmp_path, None)
    first = gen(ref)
    assert _ver(first) == 4, f"{t}: miss must mint v4"
    assert capsule(ref) == first, f"{t}: v4 written to the capsule"
    assert gen(ref) == first, f"{t}: idempotent"


# ── type-specific regressions ────────────────────────────────────────────────

def test_agent_writes_uuid_not_name_into_capsule(tmp_path: Path) -> None:
    ref = _agent(tmp_path, None)
    got = _mint("subagent", ref)
    stored_id = _capsule_id(ref)
    assert stored_id == got and _ver(stored_id) == 4
    assert _frontmatter_id(ref._path) is None
    assert stored_id not in ("My Agent", "a")
    # self-heals: second index adopts the written UUID, no rewrite
    mtime = ref._path.stat().st_mtime
    assert _mint("subagent", ref) == got
    assert ref._path.stat().st_mtime == mtime


def test_dataset_manifest_id_adopted_without_capsule_backfill(tmp_path: Path) -> None:
    ds = tmp_path / "ds"
    ds.mkdir()
    (ds / "dataset.json").write_text(f'{{"metadata": {{"id": "{V4}"}}}}', encoding="utf-8")
    assert _mint("dataset", FSRef(ds)) == V4
    assert read_folder_capsule_id(ds) is None, "legacy adoption does not backfill or clean up"
