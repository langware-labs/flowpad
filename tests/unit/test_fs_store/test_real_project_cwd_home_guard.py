"""Guard: a $HOME-rooted (or above) cwd must never become a folder-walk root.

Regression for the full-scan blowup where a stray ``~/.claude/projects/-Users-<u>``
(a Claude session whose cwd was $HOME) entered the project set. Because the
scan builds one ``REAL_PROJECT_CWD`` walk root per project — and outermost-dedup
keeps only the shallowest cwd — that one root subsumed every real project and
``project_folder_walker_fn`` recursed the entire home tree (~900k folders,
minutes per scan). ``is_home_or_ancestor`` drops it at every root-construction
site (``default_roots`` CWD_ROOT guard + ``_resolve_scoped_roots`` REAL_PROJECT_CWD
guard).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.indexer.roots import is_home_or_ancestor
from flow_sdk.fs_store.path_utils import is_path_under


def _dedup_nested(cwds: list[str]) -> list[str]:
    """Outermost-wins walk-coverage dedup — the shape ``_resolve_scoped_roots``
    applies when it builds one REAL_PROJECT_CWD root per project. Kept here
    (the retired ``real_project_cwd_fn`` walker was its only home) so the bug
    shape below stays reproducible."""
    kept: list[str] = []
    for cwd in sorted(cwds, key=len):
        if not any(is_path_under(cwd, k) for k in kept):
            kept.append(cwd)
    return kept


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
    """The bug shape: without the guard, outermost-dedup collapses everything
    into $HOME; with it, the real repos survive as distinct roots."""
    home = tmp_path / "Users" / "alice"
    repo_a = home / "dev" / "flowpad-oss"
    repo_b = home / "dev" / "other-repo"
    cwds = [str(home), str(repo_a), str(repo_b)]

    # Pre-guard: dedup alone keeps only $HOME — the blowup.
    assert _dedup_nested(cwds) == [str(home)]

    # Post-guard: drop home/ancestors first, then the real repos remain.
    safe = [c for c in cwds if not is_home_or_ancestor(c, home)]
    assert set(_dedup_nested(safe)) == {str(repo_a), str(repo_b)}
