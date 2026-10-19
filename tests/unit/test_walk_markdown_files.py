"""Unit tests for ``walk_markdown_files`` — the gitignore-aware project walk
that powers the Markdown asset menu.

Covers the doc-folder scope (only ``.md`` inside a ``docs``/``doc`` folder is a
document — a project-root README is not) plus the full gitignore matcher
contract: ``_WALK_IGNORED`` fast-path, ``.claude/`` force-include, file- and
dir-pattern ``.gitignore`` rules, nested ``.gitignore`` last-match-wins, symlink
non-following, and non-``.md`` exclusion.

The matcher tests walk a root that is itself a ``docs`` folder, so every file
under it is in scope and only the gitignore rules decide.

Real filesystem trees in ``tmp_path`` — no mocks. Fast.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.operations.markdown_dirs import walk_markdown_files


@pytest.fixture
def docs_root(tmp_path: Path) -> Path:
    root = tmp_path / "docs"
    root.mkdir()
    return root


def _touch(p: Path, text: str = "x") -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def test_only_doc_folders_are_walked(tmp_path: Path) -> None:
    """Markdown outside a ``docs``/``doc`` folder — a root README, notes in
    ``src/`` — is not a document."""
    _touch(tmp_path / "README.md")
    _touch(tmp_path / "streams_sdk.md")
    _touch(tmp_path / "src" / "notes.md")
    _touch(tmp_path / "docs" / "STREAMS-ANALYSIS.md")
    assert walk_markdown_files(tmp_path) == ["docs/STREAMS-ANALYSIS.md"]


def test_doc_and_docs_at_any_depth(tmp_path: Path) -> None:
    _touch(tmp_path / "a.md")
    _touch(tmp_path / "docs" / "b.md")
    _touch(tmp_path / "docs" / "nested" / "deep" / "c.md")
    _touch(tmp_path / "pkg" / "doc" / "d.md")
    _touch(tmp_path / ".claude" / "docs" / "e.md")
    _touch(tmp_path / "experiments" / "x" / "README.md")
    assert walk_markdown_files(tmp_path) == [
        ".claude/docs/e.md",
        "docs/b.md",
        "docs/nested/deep/c.md",
        "pkg/doc/d.md",
    ]


def test_root_that_is_a_doc_folder_walks_everything(tmp_path: Path) -> None:
    _touch(tmp_path / "docs" / "top.md")
    _touch(tmp_path / "docs" / "guides" / "g.md")
    assert walk_markdown_files(tmp_path / "docs") == ["guides/g.md", "top.md"]


def test_only_md_files(docs_root: Path) -> None:
    _touch(docs_root / "keep.md")
    _touch(docs_root / "skip.txt")
    _touch(docs_root / "skip.py")
    _touch(docs_root / "README.MD")  # case-insensitive extension
    assert walk_markdown_files(docs_root) == ["README.MD", "keep.md"]


def test_walk_ignored_dirs_pruned(docs_root: Path) -> None:
    """Hardcoded denylist (node_modules/.git/etc.) is pruned without a
    .gitignore present."""
    _touch(docs_root / "keep.md")
    _touch(docs_root / "node_modules" / "pkg" / "readme.md")
    _touch(docs_root / ".git" / "notes.md")
    _touch(docs_root / "__pycache__" / "x.md")
    assert walk_markdown_files(docs_root) == ["keep.md"]


def test_gitignore_file_pattern(docs_root: Path) -> None:
    _touch(docs_root / ".gitignore", "secret.md\n")
    _touch(docs_root / "keep.md")
    _touch(docs_root / "secret.md")
    assert walk_markdown_files(docs_root) == ["keep.md"]


def test_gitignore_dir_pattern(docs_root: Path) -> None:
    _touch(docs_root / ".gitignore", "build/\n")
    _touch(docs_root / "keep.md")
    _touch(docs_root / "build" / "out.md")
    _touch(docs_root / "build" / "sub" / "deep.md")
    assert walk_markdown_files(docs_root) == ["keep.md"]


def test_gitignore_glob_pattern(docs_root: Path) -> None:
    _touch(docs_root / ".gitignore", "*.draft.md\n")
    _touch(docs_root / "final.md")
    _touch(docs_root / "notes.draft.md")
    assert walk_markdown_files(docs_root) == ["final.md"]


def test_single_spec_negation_reincludes(docs_root: Path) -> None:
    """Within one ``.gitignore``, a ``!`` negation re-includes a file the same
    file's earlier glob ignored (the common ``ignore-all-but-one`` pattern)."""
    _touch(docs_root / ".gitignore", "*.md\n!keep.md\n")
    _touch(docs_root / "keep.md")
    _touch(docs_root / "drop.md")
    assert walk_markdown_files(docs_root) == ["keep.md"]


def test_nested_gitignore_adds_ignore(docs_root: Path) -> None:
    """A nested ``.gitignore`` adds its own ignore on top of the parent's; the
    parent's surviving files are unaffected."""
    _touch(docs_root / "root.md")
    _touch(docs_root / "sub" / ".gitignore", "local.md\n")
    _touch(docs_root / "sub" / "shared.md")
    _touch(docs_root / "sub" / "local.md")  # ignored by sub/.gitignore
    assert walk_markdown_files(docs_root) == ["root.md", "sub/shared.md"]


def test_root_pattern_prunes_deep_subfolder(tmp_path: Path) -> None:
    """A root ``.gitignore`` subfolder pattern prunes that folder AND everything
    under it, however deep."""
    _touch(tmp_path / ".gitignore", "docs/private/\n")
    _touch(tmp_path / "docs" / "ok.md")
    _touch(tmp_path / "docs" / "private" / "secret.md")
    _touch(tmp_path / "docs" / "private" / "deep" / "more.md")
    assert walk_markdown_files(tmp_path) == ["docs/ok.md"]


def test_dir_name_pattern_pruned_at_any_depth(docs_root: Path) -> None:
    """A bare ``build/`` pattern prunes a ``build`` dir wherever it appears."""
    _touch(docs_root / ".gitignore", "build/\n")
    _touch(docs_root / "a" / "keep.md")
    _touch(docs_root / "a" / "build" / "x.md")
    _touch(docs_root / "build" / "root.md")
    assert walk_markdown_files(docs_root) == ["a/keep.md"]


def test_glob_pattern_matches_at_depth(tmp_path: Path) -> None:
    _touch(tmp_path / ".gitignore", "*.tmp.md\n")
    _touch(tmp_path / "docs" / "keep.md")
    _touch(tmp_path / "docs" / "deep" / "notes.tmp.md")
    assert walk_markdown_files(tmp_path) == ["docs/keep.md"]


def test_nested_gitignore_prunes_sub_subfolder(docs_root: Path) -> None:
    """A ``.gitignore`` inside a subfolder prunes a sub-subfolder directory and
    everything beneath it, without touching siblings."""
    _touch(docs_root / "src" / ".gitignore", "vendor/\n")
    _touch(docs_root / "src" / "app.md")
    _touch(docs_root / "src" / "vendor" / "lib.md")
    _touch(docs_root / "src" / "vendor" / "deep" / "x.md")
    _touch(docs_root / "other" / "keep.md")  # sibling tree unaffected
    assert walk_markdown_files(docs_root) == ["other/keep.md", "src/app.md"]


def test_claude_force_include(docs_root: Path) -> None:
    """``.claude/`` survives even when the root .gitignore ignores it."""
    _touch(docs_root / ".gitignore", ".claude/\n")
    _touch(docs_root / "keep.md")
    _touch(docs_root / ".claude" / "skills" / "thing.md")
    assert walk_markdown_files(docs_root) == [
        ".claude/skills/thing.md",
        "keep.md",
    ]


def test_claude_worktrees_excluded(docs_root: Path) -> None:
    """``.claude/worktrees`` (agent git-worktrees, full repo copies) is skipped
    even though ``.claude/`` is otherwise force-included — otherwise a single
    discover walks every worktree's tree (tens of thousands of files)."""
    _touch(docs_root / "keep.md")
    _touch(docs_root / ".claude" / "skills" / "thing.md")  # still indexed
    _touch(docs_root / ".claude" / "worktrees" / "agent-x" / "ui" / "buried.md")  # skipped
    assert walk_markdown_files(docs_root) == [
        ".claude/skills/thing.md",
        "keep.md",
    ]


def test_symlinked_dir_not_followed(docs_root: Path) -> None:
    real = docs_root / "real"
    _touch(real / "inside.md")
    _touch(docs_root / "top.md")
    link = docs_root / "link"
    link.symlink_to(real, target_is_directory=True)
    # 'top.md' + 'real/inside.md' only; the symlink 'link/' is not descended.
    assert walk_markdown_files(docs_root) == ["real/inside.md", "top.md"]


def test_missing_or_file_root_returns_empty(tmp_path: Path) -> None:
    assert walk_markdown_files(tmp_path / "does-not-exist") == []
    f = tmp_path / "a-file.md"
    _touch(f)
    assert walk_markdown_files(f) == []


def test_empty_project(tmp_path: Path) -> None:
    assert walk_markdown_files(tmp_path) == []
