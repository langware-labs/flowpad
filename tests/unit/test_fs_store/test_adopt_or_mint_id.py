"""Named identity-capsule policy through ``TypeInfo.mint_id``.

The universal miss-policy for shareable file entities: adopt a valid v4/v5 id
from legacy frontmatter, else mint a random v4 into the named comment capsule
(never derive uuid5(path) as the persisted id — that collides across
machines on share). uuid5(path) survives only as the read-only-file fallback.
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest

from flow_sdk.capsules import AssetCapsule
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_frontmatter,
    _yaml_load,
    read_frontmatter_id,
)
from flow_sdk.fs_store.indexer.functions.markdown import markdown_id
from flow_sdk.fs_store.schema_registry import SchemaRegistry

V4 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
V5 = str(uuid.uuid5(uuid.NAMESPACE_URL, "seed"))
V7 = "018f0000-0000-7000-8000-000000000000"  # valid syntax, foreign version


def _mint(ref: FSRef) -> str:
    info = SchemaRegistry.get("markdown")
    assert info is not None
    return info.mint_entity_id(ref, derive=True, overwrite=True)


def _ver(u: str) -> int:
    return uuid.UUID(u).version


def _fm_id(p: Path):
    fm = _extract_frontmatter(p.read_text(encoding="utf-8"))
    return (_yaml_load(fm) or {}).get("id") if fm else None


def _capsule_id(p: Path):
    data = AssetCapsule.from_path(p).read("identity")
    return data.data.get("id") if data else None


def _write(p: Path, body: str, fm: str | None = None) -> None:
    p.write_text(f"---\n{fm}\n---\n\n{body}" if fm else body, encoding="utf-8")


# ── TypeInfo.mint_id (the write path) ────────────────────────────────────────

def test_adopt_v4_frontmatter_id_unchanged(tmp_path: Path) -> None:
    p = tmp_path / "a.md"
    _write(p, "body", fm=f"id: {V4}")
    mtime = p.stat().st_mtime
    assert _mint(FSRef(p)) == V4
    assert p.stat().st_mtime == mtime, "adopting must not rewrite the file"


def test_adopt_v5_frontmatter_id_unchanged(tmp_path: Path) -> None:
    """A previously-migrated uuid5 capsule id is a valid entity id → adopted, not re-minted."""
    p = tmp_path / "a.md"
    _write(p, "body", fm=f"id: {V5}")
    assert _mint(FSRef(p)) == V5


def test_foreign_v7_id_rejected_uses_stable_v5(tmp_path: Path) -> None:
    p = tmp_path / "a.md"
    _write(p, "body", fm=f"id: {V7}")
    got = _mint(FSRef(p))
    assert got == str(uuid.uuid5(uuid.NAMESPACE_URL, str(p.resolve())))
    assert _fm_id(p) == V7, "legacy frontmatter is preserved"
    assert _capsule_id(p) is None


def test_garbage_id_rejected_uses_stable_v5(tmp_path: Path) -> None:
    p = tmp_path / "a.md"
    _write(p, "body", fm="id: not-a-uuid")
    got = _mint(FSRef(p))
    assert got == str(uuid.uuid5(uuid.NAMESPACE_URL, str(p.resolve())))
    assert _fm_id(p) == "not-a-uuid"
    assert _capsule_id(p) is None


def test_no_id_mints_v4_and_persists(tmp_path: Path) -> None:
    p = tmp_path / "a.md"
    p.write_text("# body only\nnothing", encoding="utf-8")
    got = _mint(FSRef(p))
    assert _ver(got) == 4
    assert got != str(uuid.uuid5(uuid.NAMESPACE_URL, str(p.resolve()))), "not uuid5(path)"
    assert _fm_id(p) is None
    assert _capsule_id(p) == got
    assert "# body only" in p.read_text(encoding="utf-8")


def test_second_index_adopts_written_v4_idempotent(tmp_path: Path) -> None:
    p = tmp_path / "a.md"
    p.write_text("body", encoding="utf-8")
    first = _mint(FSRef(p))
    mtime = p.stat().st_mtime
    second = _mint(FSRef(p))
    assert second == first and _ver(second) == 4
    assert p.stat().st_mtime == mtime, "second index must not rewrite"


# ── markdown_id (the read-only peek) ─────────────────────────────────────────

def test_peek_adopts_v4_without_writing(tmp_path: Path) -> None:
    p = tmp_path / "a.md"
    _write(p, "body", fm=f"id: {V4}")
    mtime = p.stat().st_mtime
    assert markdown_id(FSRef(p)) == V4
    assert p.stat().st_mtime == mtime


def test_peek_on_miss_returns_derive_key_no_write(tmp_path: Path) -> None:
    p = tmp_path / "a.md"
    p.write_text("body", encoding="utf-8")
    before = p.read_text(encoding="utf-8")
    got = markdown_id(FSRef(p))
    assert got == str(uuid.uuid5(uuid.NAMESPACE_URL, str(p.resolve())))
    assert p.read_text(encoding="utf-8") == before, "peek must never touch disk"


# ── direct helper tests ──────────────────────────────────────────────────────

def test_helper_write_back_false_never_writes(tmp_path: Path) -> None:
    p = tmp_path / "a.md"
    p.write_text("no id here", encoding="utf-8")
    before = p.read_text(encoding="utf-8")
    got = read_frontmatter_id(p)
    assert got is None
    assert p.read_text(encoding="utf-8") == before


@pytest.mark.skipif(os.geteuid() == 0, reason="root bypasses chmod 0444")
def test_readonly_file_falls_back_to_stable_derived(tmp_path: Path) -> None:
    p = tmp_path / "a.md"
    p.write_text("body no id", encoding="utf-8")
    os.chmod(p, 0o444)
    os.chmod(tmp_path, 0o555)
    try:
        derived = str(uuid.uuid5(uuid.NAMESPACE_URL, str(p.resolve())))
        got = _mint(FSRef(p))
        assert got == derived, "read-only file → stable derived fallback (idempotent)"
        assert _mint(FSRef(p)) == got
        assert p.read_text(encoding="utf-8") == "body no id", "unchanged"
    finally:
        os.chmod(tmp_path, 0o755)
        os.chmod(p, 0o644)
