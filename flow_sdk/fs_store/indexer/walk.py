"""gitignore_walk — the one shared directory walk.

Generic pre-order DFS over a directory tree, yielding ``(dir_path, subdirs,
files)`` per surviving directory. All tree walkers consume this so the skip
policy lives in exactly one place (:mod:`flow_sdk.fs_store.indexer.gitignore`):

  * ``denylist`` — the ``_WALK_IGNORED`` basename fast-path plus the
    ``.claude/worktrees`` skip (:func:`is_denylisted`).
  * ``gitignore`` — the nested ``.gitignore`` stack (pushed on descend, popped
    on backtrack), with the ``.claude/`` force-include. Implies the denylist
    (``is_ignored`` consults it first). Monotonic across stacked files — a
    child ``!`` re-include of something an ancestor ``.gitignore`` ignored is
    NOT honored; negation within a single file works.

Symlinked directories are never followed; unreadable directories are skipped,
never fatal. The root is always yielded, even when a pattern matches it — the
caller asked for that tree. There is no ``os.walk``-style pruning contract:
mutating the yielded ``subdirs`` list does not affect the walk.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

from flow_sdk.fs_store.indexer.gitignore import (
    GitignoreStack,
    is_denylisted,
    is_ignored,
    load_gitignore_stack,
    push_gitignore,
)


def _scandir_sorted(d: Path) -> list[os.DirEntry]:
    """DirEntry entries of ``d`` sorted by name; empty on any I/O error.

    ``os.scandir`` serves the dir/file/symlink type from the readdir cache, so
    the per-entry checks below cost no extra ``stat`` in the common case —
    unlike ``Path.is_dir()``/``is_symlink()``/``is_file()``, which each syscall.
    """
    try:
        with os.scandir(d) as it:
            entries = list(it)
    except OSError:
        return []
    entries.sort(key=lambda e: e.name)
    return entries


def gitignore_walk(
    root: Path,
    *,
    gitignore: bool = True,
    denylist: bool = True,
    include_files: bool = True,
) -> Iterator[tuple[Path, list[Path], list[Path]]]:
    """Pre-order DFS yielding ``(dir_path, subdirs, files)`` per directory.

    ``subdirs``/``files`` are sorted ascending and already filtered per the
    module policy. ``gitignore=False, denylist=True`` skips only the hardcoded
    denylist; ``gitignore=False, denylist=False`` is a pure pass-through (only
    symlink/unreadable skips) — the FSIndexer's legacy ``gitignore=False``
    behavior. ``include_files=False`` yields empty file lists and skips the
    per-file match cost for folder-only consumers.
    """
    # The root is walked AS GIVEN — no resolve(); callers that need a
    # normalized root (e.g. for relative_to output) resolve it themselves.
    try:
        if not root.is_dir():
            return
    except OSError:
        return

    stack: GitignoreStack = load_gitignore_stack(root) if gitignore else []

    def filtered(d: Path) -> tuple[list[Path], list[Path]]:
        subdirs: list[Path] = []
        files: list[Path] = []
        for entry in _scandir_sorted(d):
            try:
                # follow_symlinks=False ⇒ a real directory, not a symlink to one
                # (matches the old ``is_dir() and not is_symlink()``).
                entry_is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if not entry_is_dir:
                if not include_files:
                    continue
                try:
                    # follow_symlinks=True (default) matches the old ``is_file()``:
                    # a symlink to a regular file still counts as a file.
                    if not entry.is_file():
                        continue
                except OSError:
                    continue
            path = Path(entry.path)
            if gitignore:
                if is_ignored(path, entry_is_dir, stack, root):
                    continue
            elif denylist and is_denylisted(path):
                continue
            (subdirs if entry_is_dir else files).append(path)
        return subdirs, files

    subdirs, files = filtered(root)
    yield root, subdirs, files

    # DFS frames: (remaining subdirs reversed so pop() walks ascending,
    # gitignore entries pushed for the frame's directory).
    frames: list[tuple[list[Path], int]] = [(list(reversed(subdirs)), 0)]
    while frames:
        remaining, pushed = frames[-1]
        if not remaining:
            if pushed:
                del stack[-pushed:]
            frames.pop()
            continue
        sub = remaining.pop()
        pushed_here = push_gitignore(stack, sub) if gitignore else 0
        sub_subdirs, sub_files = filtered(sub)
        yield sub, sub_subdirs, sub_files
        frames.append((list(reversed(sub_subdirs)), pushed_here))
