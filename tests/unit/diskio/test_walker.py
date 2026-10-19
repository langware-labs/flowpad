"""TreeWalker conformance — the per-entry decision order of spec §1.

The oracle for the flag matrix is ``gitignore_walk``, the wrapper every
existing caller keeps using.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from flow_sdk.diskio.contract import TreeWalker, WalkEntry
from flow_sdk.diskio.python.tree_walker import walk_policy
from flow_sdk.fs_store.indexer.walk import gitignore_walk
from tests.unit.diskio._backends import backends, drain, touch


@pytest.fixture(params=backends(TreeWalker))
def walker(request):
    return request.param()


def entries(walker, root: Path, **flags) -> list[WalkEntry]:
    body, end = drain(walker.walk(str(root), walk_policy(**flags)))
    assert end.counts == ({"diskio.walk_entry": len(body)} if body else {})
    return body


def rel_dirs(walker, root: Path, **flags) -> list[str]:
    return [os.path.relpath(e.dir, root) for e in entries(walker, root, **flags)]


def by_dir(walker, root: Path, **flags) -> dict[str, WalkEntry]:
    return {os.path.relpath(e.dir, root): e for e in entries(walker, root, **flags)}


def test_preorder_sorted_names(walker, tmp_path):
    touch(tmp_path / "a.md")
    touch(tmp_path / "b" / "c" / "deep.md")
    touch(tmp_path / "z" / "late.md")
    walked = entries(walker, tmp_path)
    assert [e.dir for e in walked] == [str(tmp_path / p) for p in ("", "b", "b/c", "z")]
    assert walked[0].subdirs == ("b", "z") and walked[0].files == ("a.md",)
    assert walked[2].files == ("deep.md",) and walked[2].error is None


def test_the_root_is_walked_as_given(walker, tmp_path):
    touch(tmp_path / "real" / "a.md")
    link = tmp_path / "link"
    link.symlink_to(tmp_path / "real", target_is_directory=True)
    assert [e.dir for e in entries(walker, link)] == [str(link)]


def test_denylist_drops_dirs_and_files_by_basename(walker, tmp_path):
    touch(tmp_path / "node_modules" / "pkg" / "index.md")
    touch(tmp_path / ".flow" / "state.md")
    touch(tmp_path / "src" / "build")  # a FILE named like a denied dir
    touch(tmp_path / "src" / "keep.md")
    walked = by_dir(walker, tmp_path)
    assert set(walked) == {".", "src"}
    assert walked["src"].files == ("keep.md",)


def test_claude_worktrees_are_skipped_and_claude_is_force_included(walker, tmp_path):
    touch(tmp_path / ".gitignore", ".claude/\n*.md\n")
    touch(tmp_path / ".claude" / "skills" / "one" / "SKILL.md")
    touch(tmp_path / ".claude" / "worktrees" / "wt" / "README.md")
    touch(tmp_path / "notes.md")
    walked = by_dir(walker, tmp_path)
    assert set(walked) == {".", ".claude", ".claude/skills", ".claude/skills/one"}
    assert walked[".claude/skills/one"].files == ("SKILL.md",), "force-include beats *.md"
    assert walked["."].files == (".gitignore",)


def test_force_include_applies_only_with_gitignore(walker, tmp_path):
    touch(tmp_path / ".claude" / "worktrees" / "wt" / "a.md")
    touch(tmp_path / ".claude" / "skills" / "a.md")
    assert rel_dirs(walker, tmp_path, gitignore=False, denylist=True) == [".", ".claude", ".claude/skills"]
    assert ".claude/worktrees/wt" in rel_dirs(walker, tmp_path, gitignore=False, denylist=False)


def test_nested_gitignore_applies_below_its_own_directory_only(walker, tmp_path):
    touch(tmp_path / "top.log")
    touch(tmp_path / "sub" / ".gitignore", "*.log\nprivate/\n")
    touch(tmp_path / "sub" / "a.log")
    touch(tmp_path / "sub" / "a.md")
    touch(tmp_path / "sub" / "private" / "x.md")
    touch(tmp_path / "other" / "b.log")
    walked = by_dir(walker, tmp_path)
    assert walked["."].files == ("top.log",)
    assert walked["sub"].files == (".gitignore", "a.md") and walked["sub"].subdirs == ()
    assert walked["other"].files == ("b.log",)


def test_negation_inside_one_file_re_includes(walker, tmp_path):
    touch(tmp_path / ".gitignore", "*.md\n!keep.md\n")
    touch(tmp_path / "drop.md")
    touch(tmp_path / "keep.md")
    assert by_dir(walker, tmp_path)["."].files == (".gitignore", "keep.md")


def test_a_nested_file_cannot_re_include_what_an_ancestor_ignored(walker, tmp_path):
    touch(tmp_path / ".gitignore", "*.md\n")
    touch(tmp_path / "sub" / ".gitignore", "!keep.md\n")
    touch(tmp_path / "sub" / "keep.md")
    assert by_dir(walker, tmp_path)["sub"].files == (".gitignore",)


def test_a_directory_matches_with_and_without_the_trailing_slash(walker, tmp_path):
    touch(tmp_path / ".gitignore", "out\ngen/\n")
    touch(tmp_path / "out" / "a.md")
    touch(tmp_path / "gen" / "a.md")
    touch(tmp_path / "src" / "a.md")
    assert rel_dirs(walker, tmp_path) == [".", "src"]


def test_the_root_is_yielded_even_when_everything_is_ignored(walker, tmp_path):
    touch(tmp_path / ".gitignore", "*\n")
    touch(tmp_path / "drop.md")
    touch(tmp_path / "sub" / "x.md")
    (only,) = entries(walker, tmp_path)
    assert only.dir == str(tmp_path) and only.subdirs == () and only.files == ()


def test_a_missing_or_file_root_yields_only_the_terminal(walker, tmp_path):
    assert entries(walker, tmp_path / "nope") == []
    assert entries(walker, touch(tmp_path / "a.md")) == []


def test_a_symlinked_directory_is_not_followed_and_a_symlinked_file_is_a_file(walker, tmp_path):
    touch(tmp_path / "real" / "a.md")
    (tmp_path / "linkdir").symlink_to(tmp_path / "real", target_is_directory=True)
    (tmp_path / "linkfile.md").symlink_to(tmp_path / "real" / "a.md")
    (tmp_path / "dangling.md").symlink_to(tmp_path / "gone.md")
    walked = by_dir(walker, tmp_path)
    assert set(walked) == {".", "real"}
    assert walked["."].subdirs == ("real",) and walked["."].files == ("linkfile.md",)


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="needs POSIX permissions and a non-root user")
def test_an_unreadable_directory_is_yielded_empty_with_its_errno(walker, tmp_path):
    touch(tmp_path / "locked" / "a.md")
    touch(tmp_path / "open" / "b.md")
    (tmp_path / "locked").chmod(0o000)
    try:
        walked = by_dir(walker, tmp_path)
    finally:
        (tmp_path / "locked").chmod(0o755)
    locked = walked["locked"]
    assert locked.subdirs == () and locked.files == ()
    assert locked.error is not None and locked.error.kind == "unreadable"
    assert locked.error.detail == "EACCES" and locked.error.path == str(tmp_path / "locked")
    assert walked["open"].files == ("b.md",) and walked["open"].error is None


def test_file_exts(walker, tmp_path):
    touch(tmp_path / "a.md")
    touch(tmp_path / "B.MD")
    touch(tmp_path / "c.mdx")
    touch(tmp_path / "d.txt")
    touch(tmp_path / ".md")  # a dotfile: its suffix is "", so it is not an .md file
    touch(tmp_path / "sub" / "e.md")
    every = by_dir(walker, tmp_path, file_exts=None)
    assert every["."].files == (".md", "B.MD", "a.md", "c.mdx", "d.txt")
    none = by_dir(walker, tmp_path, file_exts=())
    assert none["."].files == () and none["sub"].files == () and none["."].subdirs == ("sub",)
    md = by_dir(walker, tmp_path, file_exts=(".md",))
    assert md["."].files == ("B.MD", "a.md") and md["sub"].files == ("e.md",)
    assert by_dir(walker, tmp_path, file_exts=(".md", ".mdx"))["."].files == ("B.MD", "a.md", "c.mdx")


def test_a_bad_pattern_line_fails_as_the_shared_walk_does(walker, tmp_path):
    """Today an unparseable ``.gitignore`` line aborts the walk; the backend
    shares that walk and must not answer differently from ``gitignore_walk``."""
    touch(tmp_path / ".gitignore", "ok.md\na\\\n")
    touch(tmp_path / "a.md")

    def outcome(run):
        try:
            return run()
        except ValueError as exc:
            return type(exc).__name__

    oracle = outcome(lambda: [str(d) for d, _s, _f in gitignore_walk(tmp_path)])
    assert outcome(lambda: [e.dir for e in entries(walker, tmp_path)]) == oracle


@pytest.mark.parametrize("flags", [
    {"gitignore": True, "denylist": True},
    {"gitignore": True, "denylist": False},
    {"gitignore": False, "denylist": True},
    {"gitignore": False, "denylist": False},
])
@pytest.mark.parametrize("include_files", [True, False])
def test_flag_matrix_matches_gitignore_walk(walker, tmp_path, flags, include_files):
    touch(tmp_path / ".gitignore", "ignored/\n*.tmp\n.claude/\n")
    touch(tmp_path / "ignored" / "a.md")
    touch(tmp_path / "node_modules" / "p" / "a.md")
    touch(tmp_path / ".claude" / "agents" / "a.md")
    touch(tmp_path / ".claude" / "worktrees" / "w" / "a.md")
    touch(tmp_path / "docs" / "a.md")
    touch(tmp_path / "docs" / "b.tmp")
    touch(tmp_path / "docs" / "deep" / ".gitignore", "secret.md\n")
    touch(tmp_path / "docs" / "deep" / "secret.md")
    touch(tmp_path / "docs" / "deep" / "open.md")
    oracle = [
        (str(d), tuple(s.name for s in subs), tuple(f.name for f in files))
        for d, subs, files in gitignore_walk(tmp_path, include_files=include_files, **flags)
    ]
    got = entries(walker, tmp_path, file_exts=None if include_files else (), **flags)
    assert [(e.dir, e.subdirs, e.files) for e in got] == oracle


def test_a_name_that_is_not_utf8_is_not_dropped(walker, tmp_path):
    raw = os.fsencode(tmp_path) + b"/caf\xe9.md"
    try:
        with open(raw, "wb") as fh:
            fh.write(b"x")
    except OSError:
        pytest.skip("this filesystem refuses a filename that is not UTF-8")
    (root,) = entries(walker, tmp_path)
    assert root.files == (os.fsdecode(b"caf\xe9.md"),)
