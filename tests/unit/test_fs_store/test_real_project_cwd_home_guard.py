"""Guard: a $HOME-rooted (or above) cwd must never become a folder-walk root.

Regression for the full-scan blowup where a stray ``~/.claude/projects/-Users-<u>``
(a Claude session whose cwd was $HOME) entered the project set: the scan builds
one ``REAL_PROJECT_CWD`` walk root per project, so a $HOME root made
``project_folder_walker_fn`` recurse the entire home tree (~900k folders,
minutes per scan). ``is_home_or_ancestor`` drops it at every root-construction
site (``default_roots`` CWD_ROOT guard + ``_resolve_scoped_roots``
REAL_PROJECT_CWD guard).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.indexer.roots import is_home_or_ancestor


@pytest.mark.parametrize(
    ("rel", "expected"),
    [
        ("Users/alice", True),       # $HOME itself
        ("Users", True),             # an ancestor of $HOME
        ("", True),                  # the filesystem root (anchor)
        ("Users/alice/dev/repo", False),  # a real project inside $HOME
        ("srv/work", False),         # an unrelated path
    ],
)
def test_is_home_or_ancestor(tmp_path: Path, rel: str, expected: bool) -> None:
    # resolve() is non-strict, so the paths need not exist on disk.
    home = tmp_path / "Users" / "alice"
    target = (tmp_path / rel) if rel else Path(tmp_path.anchor)
    assert is_home_or_ancestor(target, home) is expected


def test_home_no_longer_swallows_real_projects(tmp_path: Path) -> None:
    """The bug shape as the root builders see it: a project set carrying a
    $HOME cwd beside real repos. The guard drops the $HOME entry and keeps
    every repo, so one stray session cannot turn a scoped scan into a walk of
    the whole home tree."""
    home = tmp_path / "Users" / "alice"
    repo_a = home / "dev" / "flowpad-oss"
    repo_b = home / "dev" / "other-repo"

    kept = [c for c in (home, repo_a, repo_b) if not is_home_or_ancestor(c, home)]

    assert set(kept) == {repo_a, repo_b}
