"""Doc directory discovery — shared by markdown indexer and asset routes.

Lifted from the old ``markdown_record.py`` so consumers can resolve the
doc-search dirs without instantiating any Record subclass.
"""
from __future__ import annotations

import functools
import os
from pathlib import Path

from flow_sdk.fs_store.indexer.gitignore import _WALK_IGNORED
from flow_sdk.instance_settings import get_instance_settings

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


def walk_markdown_files(root: Path) -> list[str]:
    """Recursively collect every ``.md`` file under ``root``, honoring ``.gitignore``.

    Walks the WHOLE subtree (not just ``docs/`` roots) so a project-root file
    like ``streams_sdk.md`` is found, returning sorted relative POSIX paths
    from ``root``. Delegates to the shared :func:`gitignore_walk`
    (:mod:`flow_sdk.fs_store.indexer.walk`): ``_WALK_IGNORED`` fast-path,
    ``.claude/`` force-include, nested ``.gitignore`` stack (monotonic across
    nested files — a child ``!`` re-include of something an ancestor
    ``.gitignore`` ignored is NOT honored; negation within a single file
    works). Symlinked directories are not followed; unreadable directories
    are skipped, never fatal.
    """
    from flow_sdk.fs_store.indexer.walk import gitignore_walk  # noqa: PLC0415

    try:
        root = root.resolve()
    except OSError:
        return []

    out = [
        f.relative_to(root).as_posix()
        for _dir, _subdirs, files in gitignore_walk(root)
        for f in files
        if f.name.lower().endswith(".md")
    ]
    out.sort()
    return out
