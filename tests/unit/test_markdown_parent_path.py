"""Unit tests for parent_path + vault_root population on MarkdownRecord.

These fields power the Obsidian-style Wiki folder tree. parent_path is the
immediate containing directory (absolute, canonical). vault_root is the scan
root that owns the file (one of the _doc_search_dirs() entries).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from flow_sdk.fs_records.markdown_record import MarkdownRecord, _resolve_vault_root


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def write_md(path: Path, title: str = "doc") -> Path:
    """Create a markdown file with minimal frontmatter and return the path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\ntitle: {title}\n---\n\n# {title}\n", encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# parent_path shape
# ---------------------------------------------------------------------------


def test_parent_path_equals_immediate_parent(tmp_path: Path):
    f = write_md(tmp_path / "docs" / "architecture" / "backend.md")
    rec = MarkdownRecord.from_file(f)
    assert rec.parent_path == str((tmp_path / "docs" / "architecture").resolve())


def test_parent_path_has_no_trailing_slash(tmp_path: Path):
    f = write_md(tmp_path / "docs" / "overview.md")
    rec = MarkdownRecord.from_file(f)
    assert rec.parent_path is not None
    assert not rec.parent_path.endswith("/")


def test_parent_path_at_vault_root(tmp_path: Path):
    # file directly in the vault root → parent_path IS the vault root
    f = write_md(tmp_path / "overview.md")
    rec = MarkdownRecord.from_file(f)
    assert rec.parent_path == str(tmp_path.resolve())


def test_same_basename_different_folders_distinct(tmp_path: Path):
    a = write_md(tmp_path / "docs" / "architecture" / "README.md", title="arch")
    b = write_md(tmp_path / "docs" / "runbooks" / "README.md", title="run")
    ra = MarkdownRecord.from_file(a)
    rb = MarkdownRecord.from_file(b)
    assert ra.parent_path != rb.parent_path
    assert ra.parent_path.endswith("architecture")
    assert rb.parent_path.endswith("runbooks")


def test_deeply_nested_parent_path(tmp_path: Path):
    f = write_md(tmp_path / "a" / "b" / "c" / "d" / "deep.md")
    rec = MarkdownRecord.from_file(f)
    assert rec.parent_path == str((tmp_path / "a" / "b" / "c" / "d").resolve())


def test_unicode_in_parent_path_preserved(tmp_path: Path):
    folder = tmp_path / "дока"
    f = write_md(folder / "file.md")
    rec = MarkdownRecord.from_file(f)
    assert rec.parent_path == str(folder.resolve())
    assert "дока" in rec.parent_path


# ---------------------------------------------------------------------------
# vault_root population
# ---------------------------------------------------------------------------


def test_vault_root_resolved_when_path_under_scan_root(tmp_path: Path):
    vault = tmp_path / "my-vault"
    f = write_md(vault / "sub" / "doc.md")
    with patch(
        "flow_sdk.fs_records.markdown_record._doc_search_dirs",
        return_value=[vault],
    ):
        rec = MarkdownRecord.from_file(f)
    assert rec.vault_root == str(vault.resolve())


def test_vault_root_none_when_outside_any_scan_root(tmp_path: Path):
    other = tmp_path / "not-a-vault"
    other.mkdir()
    f = write_md(tmp_path / "orphan.md")
    with patch(
        "flow_sdk.fs_records.markdown_record._doc_search_dirs",
        return_value=[other],
    ):
        rec = MarkdownRecord.from_file(f)
    assert getattr(rec, "vault_root", None) is None


def test_vault_root_picks_first_matching_root(tmp_path: Path):
    # nested scan roots: file under both inner and outer
    outer = tmp_path / "outer"
    inner = outer / "inner"
    f = write_md(inner / "doc.md")
    with patch(
        "flow_sdk.fs_records.markdown_record._doc_search_dirs",
        return_value=[outer, inner],
    ):
        rec = MarkdownRecord.from_file(f)
    # First match wins (outer comes first)
    assert rec.vault_root == str(outer.resolve())


def test_resolve_vault_root_handles_symlink(tmp_path: Path):
    real = tmp_path / "real-vault"
    real.mkdir()
    link = tmp_path / "link-vault"
    if sys.platform == "win32":
        pytest.skip("symlink support on Windows requires admin")
    link.symlink_to(real)
    f = write_md(real / "sub" / "doc.md")
    with patch(
        "flow_sdk.fs_records.markdown_record._doc_search_dirs",
        return_value=[link],
    ):
        resolved = _resolve_vault_root(f)
    assert resolved == str(real.resolve())


# ---------------------------------------------------------------------------
# Persistence round-trip
# ---------------------------------------------------------------------------


def test_parent_path_survives_meta_dict(tmp_path: Path):
    f = write_md(tmp_path / "docs" / "doc.md")
    rec = MarkdownRecord.from_file(f)
    md = rec.meta_dict()
    assert md.get("parent_path") == str((tmp_path / "docs").resolve())


def test_vault_root_survives_meta_dict(tmp_path: Path):
    vault = tmp_path / "vault"
    f = write_md(vault / "sub" / "doc.md")
    with patch(
        "flow_sdk.fs_records.markdown_record._doc_search_dirs",
        return_value=[vault],
    ):
        rec = MarkdownRecord.from_file(f)
    md = rec.meta_dict()
    assert md.get("vault_root") == str(vault.resolve())


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_from_markdown_without_path_has_no_parent_path():
    rec = MarkdownRecord.from_markdown("---\ntitle: x\n---\nhello", path=None)
    assert getattr(rec, "parent_path", None) is None
    assert getattr(rec, "vault_root", None) is None


def test_nonexistent_parent_path_accepted(tmp_path: Path):
    # parent_path is computed from path.resolve().parent; a path whose parent
    # doesn't exist should still produce a plausible absolute string.
    fake = tmp_path / "nowhere" / "file.md"
    # Not creating the parent; from_file would fail to read, so use from_markdown.
    rec = MarkdownRecord.from_markdown("hello", path=fake)
    assert rec.parent_path is not None
    assert rec.parent_path.endswith("nowhere")
