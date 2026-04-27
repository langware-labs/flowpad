"""Phase 7c genId minting tests.

Covers `MarkdownRecord.genId` / `getId` — the opt-in mechanism that writes
a portable `asset_id` into the YAML frontmatter on first encounter.
"""

from __future__ import annotations

import re
import uuid as _uuid
from pathlib import Path

import pytest

from flow_sdk.fs_records._frontmatter import _extract_body, _extract_frontmatter, _yaml_load
from flow_sdk.fs_records.markdown_record import MarkdownRecord
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
    known = "11111111-2222-3333-4444-555555555555"
    p = tmp_path / "b.md"
    _write_md(p, "# body\n", frontmatter=f"asset_id: {known}\ntitle: T\n")
    assert MarkdownRecord.getId(FSRef(p)) == known


def test_getId_also_accepts_legacy_id_key(tmp_path: Path) -> None:
    """For backward compatibility, `id:` in frontmatter is accepted as asset_id."""
    known = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    p = tmp_path / "c.md"
    _write_md(p, "# body\n", frontmatter=f"id: {known}\ntitle: T\n")
    assert MarkdownRecord.getId(FSRef(p)) == known


def test_genId_mints_when_no_frontmatter(tmp_path: Path) -> None:
    p = tmp_path / "d.md"
    p.write_text("# body only\nnothing else", encoding="utf-8")
    before_mtime = p.stat().st_mtime

    minted = MarkdownRecord.genId(FSRef(p))

    assert _UUID_RE.match(minted), f"not a uuid: {minted!r}"
    text = p.read_text(encoding="utf-8")
    fm = _extract_frontmatter(text)
    assert fm is not None, "frontmatter must be present after mint"
    assert (_yaml_load(fm) or {}).get("asset_id") == minted
    # Body survives
    assert "# body only" in _extract_body(text)
    assert "nothing else" in _extract_body(text)
    # File was actually rewritten
    assert p.stat().st_mtime >= before_mtime


def test_genId_mints_when_frontmatter_has_no_asset_id(tmp_path: Path) -> None:
    p = tmp_path / "e.md"
    _write_md(p, "# hi\n\nbody line\n", frontmatter="title: Greeting\ntags: [a, b]\n")
    original_body = _extract_body(p.read_text(encoding="utf-8"))

    minted = MarkdownRecord.genId(FSRef(p))

    assert _UUID_RE.match(minted)
    text = p.read_text(encoding="utf-8")
    fm = _extract_frontmatter(text)
    fields = _yaml_load(fm) or {}
    # Minted id lands in asset_id
    assert fields.get("asset_id") == minted
    # Existing fields preserved
    assert fields.get("title") == "Greeting"
    assert fields.get("tags") == ["a", "b"]
    # Body preserved verbatim-ish (whitespace-insensitive comparison)
    new_body = _extract_body(text)
    assert new_body.strip() == original_body.strip()


def test_genId_is_idempotent(tmp_path: Path) -> None:
    """Second call returns the same id and does not rewrite the asset_id line."""
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
    preexisting = "deadbeef-dead-beef-dead-beefdeadbeef"
    p = tmp_path / "h.md"
    _write_md(p, "# body\n", frontmatter=f"asset_id: {preexisting}\ntitle: T\n")
    mtime_before = p.stat().st_mtime

    result = MarkdownRecord.genId(FSRef(p))

    assert result == preexisting
    # File not rewritten since we had an asset_id
    assert p.stat().st_mtime == mtime_before


def test_genId_respects_legacy_id_key(tmp_path: Path) -> None:
    """`id:` already in frontmatter counts — no new mint."""
    legacy = "12345678-1234-1234-1234-123456789012"
    p = tmp_path / "i.md"
    _write_md(p, "# body\n", frontmatter=f"id: {legacy}\ntitle: T\n")
    mtime_before = p.stat().st_mtime

    result = MarkdownRecord.genId(FSRef(p))

    assert result == legacy
    assert p.stat().st_mtime == mtime_before


def test_from_file_picks_up_minted_asset_id(tmp_path: Path) -> None:
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


def test_base_record_genId_does_not_mint(tmp_path: Path) -> None:
    """Non-mintable Record subclasses default genId == getId — no write."""
    from flow_sdk.fs_records.claude.claude_plan import ClaudePlanRecord

    # Plans use uuid5(path); no frontmatter is ever written by base genId.
    p = tmp_path / "plan.md"
    p.write_text("some plan body", encoding="utf-8")
    ref = FSRef(p)

    mtime_before = p.stat().st_mtime
    result = ClaudePlanRecord.genId(ref)
    # Default genId delegates to getId
    assert result == ClaudePlanRecord.getId(ref)
    # No file write
    assert p.stat().st_mtime == mtime_before
