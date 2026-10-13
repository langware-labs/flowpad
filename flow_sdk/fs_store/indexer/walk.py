"""gitignore_walk — the one shared directory walk.

Generic pre-order DFS over a directory tree, yielding ``(dir_path, subdirs,
files)`` per surviving directory. All tree walkers consume this so the skip
policy lives in exactly one place (:mod:`flow_sdk.fs_store.gitignore`):

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
from typing import Callable, Iterator

from flow_sdk.fs_store.gitignore import (
    GitignoreStack,
    is_denylisted,
    is_ignored,
    load_gitignore_stack,
    push_gitignore,
)

#: ``skip(path, is_dir, stack)`` — True drops the entry. ``stack`` is the live
#: ``.gitignore`` stack (empty when the walk reads no ``.gitignore``).
SkipFn = Callable[[Path, bool, GitignoreStack], bool]


def _scandir(d: Path) -> tuple[list[os.DirEntry], OSError | None]:
    """DirEntry entries of ``d`` sorted by name, plus the error that emptied
    the listing (``None`` when it was read).

    ``os.scandir`` serves the dir/file/symlink type from the readdir cache, so
    the per-entry checks below cost no extra ``stat`` in the common case —
    unlike ``Path.is_dir()``/``is_symlink()``/``is_file()``, which each syscall.
    """
    try:
        with os.scandir(d) as it:
            entries = list(it)
    except OSError as error:
        return [], error
    entries.sort(key=lambda e: e.name)
    return entries, None


def walk_entries(
    root: Path,
    *,
    gitignore: bool,
    include_files: bool,
    skip: SkipFn | None,
) -> Iterator[tuple[Path, list[Path], list[Path], OSError | None]]:
    """The walk itself: pre-order DFS yielding ``(dir_path, subdirs, files,
    error)`` per surviving directory.

    The ONE descent — :func:`gitignore_walk` and ``flow_sdk.diskio``'s Python
    ``TreeWalker`` are both thin views of it. ``gitignore`` says whether the
    nested ``.gitignore`` stack is read (pushed on descend, popped on
    backtrack); ``skip`` decides each entry and is handed that stack. ``error``
    is the ``OSError`` that left a directory's listing empty, ``None`` when it
    was read.
    """
    # The root is walked AS GIVEN — no resolve(); callers that need a
    # normalized root (e.g. for relative_to output) resolve it themselves.
    try:
        if not root.is_dir():
            return
    except OSError:
        return

    stack: GitignoreStack = load_gitignore_stack(root) if gitignore else []

    def filtered(d: Path) -> tuple[list[Path], list[Path], OSError | None]:
        subdirs: list[Path] = []
        files: list[Path] = []
        entries, error = _scandir(d)
        for entry in entries:
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
            if skip is not None and skip(path, entry_is_dir, stack):
                continue
            (subdirs if entry_is_dir else files).append(path)
        return subdirs, files, error

    subdirs, files, error = filtered(root)
    yield root, subdirs, files, error

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
        sub_subdirs, sub_files, sub_error = filtered(sub)
        yield sub, sub_subdirs, sub_files, sub_error
        frames.append((list(reversed(sub_subdirs)), pushed_here))


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
    staged = _stage1_walk(root, gitignore=gitignore, denylist=denylist, include_files=include_files)
    if staged is not None:
        yield from staged
        return
    skip: SkipFn | None
    if gitignore:
        def skip(path: Path, is_dir: bool, stack: GitignoreStack) -> bool:
            return is_ignored(path, is_dir, stack, root)
    elif denylist:
        def skip(path: Path, is_dir: bool, stack: GitignoreStack) -> bool:
            return is_denylisted(path)
    else:
        skip = None
    for dir_path, subdirs, files, _error in walk_entries(
        root, gitignore=gitignore, include_files=include_files, skip=skip,
    ):
        yield dir_path, subdirs, files


def _stage1_walk(
    root: Path, *, gitignore: bool, denylist: bool, include_files: bool,
) -> Iterator[tuple[Path, list[Path], list[Path]]] | None:
    """The same walk from the ``diskio`` stage-1 backend, or None to run the descent above.

    None whenever Python would answer (the default; ``stage1_items`` decides), so the
    in-process walk stays the lazy generator it always was. The Python backend reaches
    the descent through ``walk_entries``, never through here — there is no way back in.
    """
    from flow_sdk.diskio.stage1 import stage1_items  # noqa: PLC0415 — diskio imports this module

    # Only where .gitignore matching is the cost. Without it a walk is bounded by directory
    # reads, and shipping every file name across a process boundary costs more than it saves.
    if not gitignore:
        return None
    try:
        if not root.is_dir():
            return None
    except OSError:
        return None
    items = stage1_items(str(root), gitignore=gitignore, denylist=denylist,
                         file_exts=None if include_files else ())
    if items is None:
        return None
    # Paths are built as each entry is consumed: only the verified names are held.
    return (
        (base, [base / name for name in entry.subdirs], [base / name for name in entry.files])
        for entry in items
        for base in (Path(entry.dir),)
    )
