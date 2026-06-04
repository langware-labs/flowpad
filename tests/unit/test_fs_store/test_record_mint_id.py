"""Phase 7d (refactor) — genId minting tests.

Covers `MarkdownRecord.genId` / `getId` and the same pattern mirrored across
other frontmatter-bearing record classes. The contract:

  - Field name in frontmatter is `id` (legacy `asset_id` still accepted for
    reads but never written for new mints).
  - `genId` is idempotent: re-running on an already-stamped file is a no-op.
  - `genId` is migration-safe: when the file has no id yet, it writes the
    value `getId` would have derived (e.g. uuid5(path)) — not a fresh uuid4 —
    so any DB row already keyed by that derived value remains valid.
"""

from __future__ import annotations

import re
import uuid as _uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store.indexer._frontmatter import _extract_body, _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.indexer.functions.markdown import (
    markdown_gen_id as _markdown_gen_id,
    markdown_id as _markdown_id,
    extract_markdown as _extract_markdown,
)

class _MarkdownRecordAdapter:
    _mintable = True
    @staticmethod
    def getId(ref):
        return _markdown_id(ref)
    @staticmethod
    def genId(ref):
        return _markdown_gen_id(ref)
    @staticmethod
    def from_file(path):
        from flow_sdk.fs_store.fs_ref import FSRef
        return _extract_markdown(FSRef(path))[0]

MarkdownRecord = _MarkdownRecordAdapter
from flow_sdk.fs_store.fs_ref import FSRef


_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _write_md(p: Path, body: str, frontmatter: str | None = None) -> None:
    if frontmatter is None:
        p.write_text(body, encoding="utf-8")
    else:
        p.write_text(f"---\n{frontmatter}\n---\n\n{body}", encoding="utf-8")


def test_mintable_flag_is_true() -> None:
    assert MarkdownRecord._mintable is True


def test_getId_without_asset_id_returns_path_uuid5(tmp_path: Path) -> None:
    p = tmp_path / "a.md"
    _write_md(p, "# body\n", frontmatter="title: T\n")
    ref = FSRef(p)
    expected = str(_uuid.uuid5(_uuid.NAMESPACE_URL, str(p.resolve())))
    assert MarkdownRecord.getId(ref) == expected


def test_getId_reads_asset_id_from_frontmatter(tmp_path: Path) -> None:
    """Legacy `asset_id:` field is still read."""
    known = "11111111-2222-4333-8444-555555555555"
    p = tmp_path / "b.md"
    _write_md(p, "# body\n", frontmatter=f"asset_id: {known}\ntitle: T\n")
    assert MarkdownRecord.getId(FSRef(p)) == known


def test_getId_reads_id_from_frontmatter(tmp_path: Path) -> None:
    """New `id:` field is read with precedence."""
    known = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    p = tmp_path / "c.md"
    _write_md(p, "# body\n", frontmatter=f"id: {known}\ntitle: T\n")
    assert MarkdownRecord.getId(FSRef(p)) == known


def test_genId_mints_path_uuid5_when_no_frontmatter(tmp_path: Path) -> None:
    """Migration-safe: writes the derived id (uuid5 of path), not a fresh uuid4.

    This is what guarantees existing DB rows (keyed by that derived value)
    keep resolving after the first scan.
    """
    p = tmp_path / "d.md"
    p.write_text("# body only\nnothing else", encoding="utf-8")
    before_mtime = p.stat().st_mtime
    expected_derived = str(_uuid.uuid5(_uuid.NAMESPACE_URL, str(p.resolve())))

    minted = MarkdownRecord.genId(FSRef(p))

    assert _UUID_RE.match(minted), f"not a uuid: {minted!r}"
    assert minted == expected_derived, "genId must preserve the derived id"
    text = p.read_text(encoding="utf-8")
    fm = _extract_frontmatter(text)
    assert fm is not None, "frontmatter must be present after mint"
    # Field is `id`, not `asset_id`
    assert (_yaml_load(fm) or {}).get("id") == minted
    assert (_yaml_load(fm) or {}).get("asset_id") is None
    # Body survives
    assert "# body only" in _extract_body(text)
    assert "nothing else" in _extract_body(text)
    # File was actually rewritten
    assert p.stat().st_mtime >= before_mtime


def test_genId_mints_when_frontmatter_has_no_id(tmp_path: Path) -> None:
    p = tmp_path / "e.md"
    _write_md(p, "# hi\n\nbody line\n", frontmatter="title: Greeting\ntags: [a, b]\n")
    original_body = _extract_body(p.read_text(encoding="utf-8"))

    minted = MarkdownRecord.genId(FSRef(p))

    assert _UUID_RE.match(minted)
    text = p.read_text(encoding="utf-8")
    fm = _extract_frontmatter(text)
    fields = _yaml_load(fm) or {}
    # Minted id lands in `id`
    assert fields.get("id") == minted
    # Existing fields preserved
    assert fields.get("title") == "Greeting"
    assert fields.get("tags") == ["a", "b"]
    # Body preserved verbatim-ish (whitespace-insensitive comparison)
    new_body = _extract_body(text)
    assert new_body.strip() == original_body.strip()


def test_genId_is_idempotent(tmp_path: Path) -> None:
    """Second call returns the same id and does not rewrite the file."""
    p = tmp_path / "f.md"
    _write_md(p, "# hi\n", frontmatter="title: T\n")

    first = MarkdownRecord.genId(FSRef(p))
    text_after_first = p.read_text(encoding="utf-8")

    second = MarkdownRecord.genId(FSRef(p))
    text_after_second = p.read_text(encoding="utf-8")

    assert first == second, "genId must be stable across calls on the same asset"
    # No rewrite the second time
    assert text_after_first == text_after_second


def test_getId_after_genId_returns_minted(tmp_path: Path) -> None:
    p = tmp_path / "g.md"
    _write_md(p, "# body\n", frontmatter="title: T\n")
    minted = MarkdownRecord.genId(FSRef(p))
    assert MarkdownRecord.getId(FSRef(p)) == minted


def test_genId_does_not_overwrite_existing_asset_id(tmp_path: Path) -> None:
    """Legacy `asset_id:` is respected; no rewrite, no rename to `id`."""
    preexisting = "deadbeef-dead-4eef-8ead-beefdeadbeef"
    p = tmp_path / "h.md"
    _write_md(p, "# body\n", frontmatter=f"asset_id: {preexisting}\ntitle: T\n")
    mtime_before = p.stat().st_mtime

    result = MarkdownRecord.genId(FSRef(p))

    assert result == preexisting
    # File not rewritten since legacy asset_id was present
    assert p.stat().st_mtime == mtime_before


def test_genId_respects_existing_id_key(tmp_path: Path) -> None:
    """`id:` already in frontmatter counts — no new mint."""
    existing = "12345678-1234-4234-8234-123456789012"
    p = tmp_path / "i.md"
    _write_md(p, "# body\n", frontmatter=f"id: {existing}\ntitle: T\n")
    mtime_before = p.stat().st_mtime

    result = MarkdownRecord.genId(FSRef(p))

    assert result == existing
    assert p.stat().st_mtime == mtime_before


def test_from_file_picks_up_minted_id(tmp_path: Path) -> None:
    """After minting, from_file builds a record whose .id matches the minted value."""
    p = tmp_path / "j.md"
    _write_md(p, "# body\n", frontmatter="title: T\n")
    minted = MarkdownRecord.genId(FSRef(p))
    rec = MarkdownRecord.from_file(p)
    assert rec.id == minted


def test_genId_on_empty_file_still_returns_id(tmp_path: Path) -> None:
    p = tmp_path / "k.md"
    p.write_text("", encoding="utf-8")
    minted = MarkdownRecord.genId(FSRef(p))
    assert _UUID_RE.match(minted)
    text = p.read_text(encoding="utf-8")
    assert _extract_frontmatter(text) is not None


def test_claude_plan_genId_also_mints(tmp_path: Path) -> None:
    """ClaudePlanRecord now has its own genId override and mints into frontmatter.

    Mirrors the markdown contract: idempotent, migration-safe (writes the
    derived path-uuid5 so any existing DB row by that id stays valid).
    """
    from flow_sdk.fs_store.indexer.functions.claude_plan import claude_plan_gen_id
    ClaudePlanRecord = type('CP', (), {'genId': staticmethod(claude_plan_gen_id)})

    p = tmp_path / "plan.md"
    p.write_text("some plan body", encoding="utf-8")
    ref = FSRef(p)
    expected_derived = str(_uuid.uuid5(_uuid.NAMESPACE_URL, str(p.resolve())))

    result = ClaudePlanRecord.genId(ref)
    assert result == expected_derived
    # File was rewritten with frontmatter containing the minted id
    text = p.read_text(encoding="utf-8")
    fm = _extract_frontmatter(text)
    assert fm is not None
    assert (_yaml_load(fm) or {}).get("id") == result
    # Body preserved
    assert "some plan body" in _extract_body(text)

    # Idempotent on second call
    mtime_after_first = p.stat().st_mtime
    result2 = ClaudePlanRecord.genId(ref)
    assert result2 == result
    assert p.stat().st_mtime == mtime_after_first
