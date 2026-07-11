"""Capsule-v4 folder policy: the ``.flow/id`` sidecar + skill adoption.

A folder-backed entity carries its id in ``<folder>/.flow/id`` — the portable,
move-safe capsule (survives rename, travels on share/copy, and is the only home
for a main-doc-less folder's id). On a miss: mint a random v4 and write it. No
name/path derivation (the cross-machine collision source).
"""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions._folder_capsule import (
    folder_capsule_gen_id,
    read_folder_capsule_id,
    write_folder_capsule_id,
)
from flow_sdk.fs_store.indexer.functions.skill import (
    extract_skill,
    skill_gen_id,
    skill_id_from_name,
)

V4 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
V7 = "018f0000-0000-7000-8000-000000000000"


def _ver(u: str) -> int:
    return uuid.UUID(u).version


def _cap(folder: Path):
    return (folder / ".flow" / "id")


# ── the .flow/id capsule ─────────────────────────────────────────────────────

def test_valid_flow_id_is_adopted(tmp_path: Path) -> None:
    d = tmp_path / "e"
    d.mkdir()
    write_folder_capsule_id(d, V4)
    assert read_folder_capsule_id(d) == V4
    before = _cap(d).read_text(encoding="utf-8")
    assert folder_capsule_gen_id(d) == V4
    assert _cap(d).read_text(encoding="utf-8") == before, "adopt must not rewrite"


def test_missing_capsule_mints_v4_and_is_idempotent(tmp_path: Path) -> None:
    d = tmp_path / "e"
    d.mkdir()
    first = folder_capsule_gen_id(d)
    assert _ver(first) == 4
    assert _cap(d).read_text(encoding="utf-8").strip() == first
    assert folder_capsule_gen_id(d) == first, "second call adopts the written id"


def test_capsule_survives_move_and_rename(tmp_path: Path) -> None:
    a = tmp_path / "a"
    a.mkdir()
    cid = folder_capsule_gen_id(a)
    b = tmp_path / "nested" / "renamed"
    b.parent.mkdir()
    shutil.move(str(a), str(b))
    assert folder_capsule_gen_id(b) == cid, "id lives in the folder, not the path"


@pytest.mark.parametrize("garbage", ["not-a-uuid", "", V7, "12345678-1234-1234-8234-123456789012"])
def test_foreign_or_garbage_id_rejected_and_reminted(tmp_path: Path, garbage: str) -> None:
    d = tmp_path / "e"
    d.mkdir()
    (d / ".flow").mkdir()
    _cap(d).write_text(garbage, encoding="utf-8")
    assert read_folder_capsule_id(d) is None
    got = folder_capsule_gen_id(d)
    assert _ver(got) == 4 and got != garbage
    assert _cap(d).read_text(encoding="utf-8").strip() == got


def test_main_doc_less_folder_gets_id_purely_from_flow(tmp_path: Path) -> None:
    d = tmp_path / "proj"
    d.mkdir()
    (d / "data.txt").write_text("arbitrary", encoding="utf-8")  # no SKILL.md/PROJECT.md
    cid = folder_capsule_gen_id(d)
    assert _ver(cid) == 4
    assert _cap(d).exists()
    # only .flow/id was added
    assert sorted(p.name for p in d.iterdir()) == [".flow", "data.txt"]
    assert folder_capsule_gen_id(d) == cid


# ── skill migrates onto the capsule (folder reference type) ──────────────────

def test_skill_roundtrips_via_capsule_not_name(tmp_path: Path) -> None:
    sk = tmp_path / "skills" / "deploy"
    sk.mkdir(parents=True)
    (sk / "SKILL.md").write_text("---\nname: deploy\n---\n\nskill body", encoding="utf-8")
    sid = skill_gen_id(FSRef(sk))
    assert _ver(sid) == 4
    assert sid != skill_id_from_name("deploy"), "must NOT be uuid5(skill:name)"
    assert read_folder_capsule_id(sk) == sid
    # rename the skill folder → id survives (pre-refactor would re-derive uuid5(new-name))
    sk2 = tmp_path / "skills" / "renamed"
    sk.rename(sk2)
    assert skill_gen_id(FSRef(sk2)) == sid


def test_skill_valid_frontmatter_id_backfilled_into_capsule(tmp_path: Path) -> None:
    sk = tmp_path / "skills" / "x"
    sk.mkdir(parents=True)
    (sk / "SKILL.md").write_text(f"---\nname: x\nid: {V4}\n---\n\nbody", encoding="utf-8")
    assert not _cap(sk).exists()
    assert skill_gen_id(FSRef(sk)) == V4, "valid frontmatter id adopted"
    assert read_folder_capsule_id(sk) == V4, "and backfilled into .flow/id"


def test_indexing_skill_md_file_paths_dont_collide(tmp_path: Path) -> None:
    """VIBE-004: indexing a direct ``SKILL.md`` FILE path (the CLI/`discover_
    record_by_path` single-file fast path) must not give every skill the same id.

    ``extract_skill`` on a non-dir ref sees only ``path.name == "SKILL.md"``, so
    the name-derived fallback yields ``uuid5(skill:SKILL.md)`` for EVERY skill —
    distinct folders collide on one TypeId and overwrite each other's asset_ref.
    """
    ids = set()
    for nm in ("vibe-qa-greeter", "vibe-qa-bundle"):
        md = tmp_path / nm / "SKILL.md"
        md.parent.mkdir(parents=True)
        md.write_text(f"---\nname: {nm}\n---\n\nbody {nm}", encoding="utf-8")
        ids.add(extract_skill(FSRef(md))[0].id)  # FILE path, as the CLI passes
    assert len(ids) == 2, f"distinct skill folders collided on one id: {ids}"


def test_yaml_only_skill_persists_capsule_id(tmp_path: Path) -> None:
    """The old code SKIPPED write-back for yaml-based skills — they re-derived
    every index. Now they persist a v4 into the capsule."""
    sk = tmp_path / "skills" / "y"
    sk.mkdir(parents=True)
    (sk / "skill.yaml").write_text("name: y\n", encoding="utf-8")
    sid = skill_gen_id(FSRef(sk))
    assert _ver(sid) == 4
    assert read_folder_capsule_id(sk) == sid
    assert skill_gen_id(FSRef(sk)) == sid, "idempotent for yaml skills too"
