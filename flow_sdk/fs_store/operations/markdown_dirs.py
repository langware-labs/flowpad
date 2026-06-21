"""Doc directory discovery — shared by markdown indexer and asset routes.

Lifted from the old ``markdown_record.py`` so consumers can resolve the
doc-search dirs without instantiating any Record subclass.
"""
from __future__ import annotations

import functools
import os
from pathlib import Path

from flow_sdk.instance_settings import get_instance_settings


_WALK_IGNORED: frozenset[str] = frozenset({
    ".git", "node_modules", ".venv", "venv", "__pycache__",
    ".tox", "dist", "build", ".eggs", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".next", ".nuxt", "coverage", ".cache",
})

_DOCS_WALK_MAX_DEPTH = 3


def _find_docs_subdirs(root: Path) -> list[Path]:
    """All directories named 'docs' under root, capped at _DOCS_WALK_MAX_DEPTH."""
    found: list[Path] = []
    root_depth = len(root.parts)
    try:
        for dirpath, dirnames, _ in os.walk(root, topdown=True):
            p = Path(dirpath)
            depth = len(p.parts) - root_depth
            if depth >= _DOCS_WALK_MAX_DEPTH:
                dirnames.clear()
                continue
            dirnames[:] = [d for d in dirnames if d not in _WALK_IGNORED]
            if p.name == "docs":
                found.append(p)
    except PermissionError:
        pass
    return found


def _fingerprint() -> tuple:
    try:
        proj_dir = get_instance_settings().claude_projects_dir
        projects = (
            tuple(sorted(p.name for p in proj_dir.iterdir()))
            if proj_dir.is_dir() else ()
        )
    except OSError:
        projects = ()
    return (os.getcwd(), os.environ.get("FLOWPAD_DOC_DIRS", ""), projects)


@functools.lru_cache(maxsize=4)
def _doc_search_dirs_cached(_fp: tuple) -> tuple[Path, ...]:
    dirs: list[Path] = []
    seen: set[Path] = set()

    def _add(p: Path) -> None:
        try:
            rp = p.resolve()
        except OSError:
            return
        if rp in seen or not rp.is_dir():
            return
        seen.add(rp)
        dirs.append(rp)

    _add(get_instance_settings().claude_docs_dir)

    try:
        from flow_sdk.config import flowpad_assistant_project_root
        _add(flowpad_assistant_project_root() / "docs")
        _add(flowpad_assistant_project_root() / ".claude" / "docs")
    except Exception:
        pass

    try:
        from flow_sdk.fs_store.indexer.functions._claude_projects import iter_claude_project_paths
        for real in iter_claude_project_paths():
            for d in _find_docs_subdirs(real):
                _add(d)
            _add(real / "docs")
            _add(real / ".claude" / "docs")
    except Exception:
        pass

    _add(Path(os.getcwd()) / "docs")
    _add(Path(os.getcwd()) / ".claude" / "docs")
    for d in _find_docs_subdirs(Path(os.getcwd())):
        _add(d)

    for extra in os.environ.get("FLOWPAD_DOC_DIRS", "").split(":"):
        if extra.strip():
            _add(Path(extra.strip()))

    return tuple(dirs)


def doc_search_dirs() -> tuple[Path, ...]:
    """Return resolved doc search directories. Memoised on an input fingerprint."""
    return _doc_search_dirs_cached(_fingerprint())


def _iter_dir_sorted(d: Path) -> list[Path]:
    """Sorted entries of ``d``; empty on any I/O error. Symlinks NOT resolved."""
    try:
        return sorted(d.iterdir())
    except (OSError, PermissionError):
        return []


def walk_markdown_files(root: Path) -> list[str]:
    """Recursively collect every ``.md`` file under ``root``, honoring ``.gitignore``.

    Walks the WHOLE subtree (not just ``docs/`` roots) so a project-root file
    like ``streams_sdk.md`` is found, returning sorted relative POSIX paths
    from ``root``. Uses the same matcher as the indexer's project folder
    walker (:mod:`flow_sdk.fs_store.indexer.gitignore`):

      1. ``_WALK_IGNORED`` basename fast-path (``.git``, ``node_modules``, …).
      2. ``.claude/`` force-include (skill/agent docs survive a gitignored
         ``.claude``).
      3. A nested ``.gitignore`` stack, pushed as the walk descends into a
         directory that owns one and popped on backtrack. An ignore is
         monotonic across nested files — a child ``!`` re-include of something
         an ancestor ``.gitignore`` ignored is NOT honored (a limitation of the
         shared ``is_ignored`` matcher); negation within a single file works.

    Symlinked directories are not followed. Any unreadable directory is
    skipped, never fatal.
    """
    from flow_sdk.fs_store.indexer.gitignore import (  # noqa: PLC0415
        GitignoreStack,
        is_ignored,
        load_gitignore_stack,
        push_gitignore,
    )

    try:
        root = root.resolve()
    except OSError:
        return []
    if not root.is_dir():
        return []

    out: list[str] = []
    stack: GitignoreStack = load_gitignore_stack(root)
    # DFS frames: (dir, remaining-entries-to-pop, gitignore-entries-pushed-here).
    frames: list[tuple[Path, list[Path], int]] = [(root, _iter_dir_sorted(root), 0)]
    while frames:
        _, remaining, pushed = frames[-1]
        if not remaining:
            if pushed:
                del stack[-pushed:]
            frames.pop()
            continue
        entry = remaining.pop()
        try:
            is_dir = entry.is_dir() and not entry.is_symlink()
        except OSError:
            continue
        if is_ignored(entry, is_dir, stack, root):
            continue
        if is_dir:
            pushed_here = push_gitignore(stack, entry)
            frames.append((entry, _iter_dir_sorted(entry), pushed_here))
        elif entry.name.lower().endswith(".md"):
            out.append(entry.relative_to(root).as_posix())

    out.sort()
    return out
