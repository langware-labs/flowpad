"""Unit tests for ``walk_markdown_files`` — the gitignore-aware project walk
that powers the Markdown asset menu.

Covers the bug it was written for (a project-ROOT ``.md`` was invisible because
the menu only walked ``docs/`` vault roots) plus the full gitignore matcher
contract: ``_WALK_IGNORED`` fast-path, ``.claude/`` force-include, file- and
dir-pattern ``.gitignore`` rules, nested ``.gitignore`` last-match-wins, symlink
non-following, and non-``.md`` exclusion.

Real filesystem trees in ``tmp_path`` — no mocks. Fast.
"""
from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.operations.markdown_dirs import walk_markdown_files


def _touch(p: Path, text: str = "x") -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def test_root_level_md_is_found(tmp_path: Path) -> None:
    """The regression: a ``.md`` at the project root must be walked, not only
    files under a ``docs/`` subfolder."""
    _touch(tmp_path / "streams_sdk.md")
    _touch(tmp_path / "docs" / "STREAMS-ANALYSIS.md")
    assert walk_markdown_files(tmp_path) == [
        "docs/STREAMS-ANALYSIS.md",
        "streams_sdk.md",
    ]


def test_walks_entire_tree_sorted(tmp_path: Path) -> None:
    _touch(tmp_path / "a.md")
    _touch(tmp_path / "docs" / "b.md")
    _touch(tmp_path / "docs" / "nested" / "deep" / "c.md")
    _touch(tmp_path / "experiments" / "x" / "README.md")
    assert walk_markdown_files(tmp_path) == [
        "a.md",
        "docs/b.md",
        "docs/nested/deep/c.md",
        "experiments/x/README.md",
    ]


def test_only_md_files(tmp_path: Path) -> None:
    _touch(tmp_path / "keep.md")
    _touch(tmp_path / "skip.txt")
    _touch(tmp_path / "skip.py")
    _touch(tmp_path / "README.MD")  # case-insensitive extension
    assert walk_markdown_files(tmp_path) == ["README.MD", "keep.md"]


def test_walk_ignored_dirs_pruned(tmp_path: Path) -> None:
    """Hardcoded denylist (node_modules/.git/etc.) is pruned without a
    .gitignore present."""
    _touch(tmp_path / "keep.md")
    _touch(tmp_path / "node_modules" / "pkg" / "readme.md")
    _touch(tmp_path / ".git" / "notes.md")
    _touch(tmp_path / "__pycache__" / "x.md")
    assert walk_markdown_files(tmp_path) == ["keep.md"]


def test_gitignore_file_pattern(tmp_path: Path) -> None:
    _touch(tmp_path / ".gitignore", "secret.md\n")
    _touch(tmp_path / "keep.md")
    _touch(tmp_path / "secret.md")
    assert walk_markdown_files(tmp_path) == ["keep.md"]


def test_gitignore_dir_pattern(tmp_path: Path) -> None:
    _touch(tmp_path / ".gitignore", "build/\n")
    _touch(tmp_path / "keep.md")
    _touch(tmp_path / "build" / "out.md")
    _touch(tmp_path / "build" / "sub" / "deep.md")
    assert walk_markdown_files(tmp_path) == ["keep.md"]


def test_gitignore_glob_pattern(tmp_path: Path) -> None:
    _touch(tmp_path / ".gitignore", "*.draft.md\n")
    _touch(tmp_path / "final.md")
    _touch(tmp_path / "notes.draft.md")
    assert walk_markdown_files(tmp_path) == ["final.md"]


def test_single_spec_negation_reincludes(tmp_path: Path) -> None:
    """Within one ``.gitignore``, a ``!`` negation re-includes a file the same
    file's earlier glob ignored (the common ``ignore-all-but-one`` pattern)."""
    _touch(tmp_path / ".gitignore", "*.md\n!keep.md\n")
    _touch(tmp_path / "keep.md")
    _touch(tmp_path / "drop.md")
    assert walk_markdown_files(tmp_path) == ["keep.md"]


def test_nested_gitignore_adds_ignore(tmp_path: Path) -> None:
    """A nested ``.gitignore`` adds its own ignore on top of the parent's; the
    parent's surviving files are unaffected."""
    _touch(tmp_path / "root.md")
    _touch(tmp_path / "sub" / ".gitignore", "local.md\n")
    _touch(tmp_path / "sub" / "shared.md")
    _touch(tmp_path / "sub" / "local.md")  # ignored by sub/.gitignore
    assert walk_markdown_files(tmp_path) == ["root.md", "sub/shared.md"]


def test_root_pattern_prunes_deep_subfolder(tmp_path: Path) -> None:
    """A root ``.gitignore`` subfolder pattern prunes that folder AND everything
    under it, however deep."""
    _touch(tmp_path / ".gitignore", "docs/private/\n")
    _touch(tmp_path / "docs" / "ok.md")
    _touch(tmp_path / "docs" / "private" / "secret.md")
    _touch(tmp_path / "docs" / "private" / "deep" / "more.md")
    assert walk_markdown_files(tmp_path) == ["docs/ok.md"]


def test_dir_name_pattern_pruned_at_any_depth(tmp_path: Path) -> None:
    """A bare ``build/`` pattern prunes a ``build`` dir wherever it appears."""
    _touch(tmp_path / ".gitignore", "build/\n")
    _touch(tmp_path / "a" / "keep.md")
    _touch(tmp_path / "a" / "build" / "x.md")
    _touch(tmp_path / "build" / "root.md")
    assert walk_markdown_files(tmp_path) == ["a/keep.md"]


def test_glob_pattern_matches_at_depth(tmp_path: Path) -> None:
    _touch(tmp_path / ".gitignore", "*.tmp.md\n")
    _touch(tmp_path / "docs" / "keep.md")
    _touch(tmp_path / "docs" / "deep" / "notes.tmp.md")
    assert walk_markdown_files(tmp_path) == ["docs/keep.md"]


def test_nested_gitignore_prunes_sub_subfolder(tmp_path: Path) -> None:
    """A ``.gitignore`` inside a subfolder prunes a sub-subfolder directory and
    everything beneath it, without touching siblings."""
    _touch(tmp_path / "src" / ".gitignore", "vendor/\n")
    _touch(tmp_path / "src" / "app.md")
    _touch(tmp_path / "src" / "vendor" / "lib.md")
    _touch(tmp_path / "src" / "vendor" / "deep" / "x.md")
    _touch(tmp_path / "other" / "keep.md")  # sibling tree unaffected
    assert walk_markdown_files(tmp_path) == ["other/keep.md", "src/app.md"]


def test_claude_force_include(tmp_path: Path) -> None:
    """``.claude/`` survives even when the root .gitignore ignores it."""
    _touch(tmp_path / ".gitignore", ".claude/\n")
    _touch(tmp_path / "keep.md")
    _touch(tmp_path / ".claude" / "skills" / "thing.md")
    assert walk_markdown_files(tmp_path) == [
        ".claude/skills/thing.md",
        "keep.md",
    ]


def test_claude_worktrees_excluded(tmp_path: Path) -> None:
    """``.claude/worktrees`` (agent git-worktrees, full repo copies) is skipped
    even though ``.claude/`` is otherwise force-included — otherwise a single
    discover walks every worktree's tree (tens of thousands of files)."""
    _touch(tmp_path / "keep.md")
    _touch(tmp_path / ".claude" / "skills" / "thing.md")  # still indexed
    _touch(tmp_path / ".claude" / "worktrees" / "agent-x" / "ui" / "buried.md")  # skipped
    assert walk_markdown_files(tmp_path) == [
        ".claude/skills/thing.md",
        "keep.md",
    ]


def test_symlinked_dir_not_followed(tmp_path: Path) -> None:
    real = tmp_path / "real"
    _touch(real / "inside.md")
    _touch(tmp_path / "top.md")
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    # 'top.md' + 'real/inside.md' only; the symlink 'link/' is not descended.
    assert walk_markdown_files(tmp_path) == ["real/inside.md", "top.md"]


def test_missing_or_file_root_returns_empty(tmp_path: Path) -> None:
    assert walk_markdown_files(tmp_path / "does-not-exist") == []
    f = tmp_path / "a-file.md"
    _touch(f)
    assert walk_markdown_files(f) == []


def test_empty_project(tmp_path: Path) -> None:
    assert walk_markdown_files(tmp_path) == []
