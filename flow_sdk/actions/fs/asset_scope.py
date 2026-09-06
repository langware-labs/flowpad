"""Resolve the git scope — single file vs containing folder — of an on-disk asset.

A single-file asset (markdown) is versioned and diffed at its own file. A
folder asset (skill, agent, spec — ``asset_ref`` is the folder) is versioned
and diffed across its WHOLE folder, so edits to its internal files (scripts,
references) are tracked as revisions of the asset instead of being silently
dropped. The dividing line is the type's shape — this module is the single
seam both the versioning hook and the git-ops endpoints consult, so the
folder↔file convention lives in exactly one place.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def _folder_backed_types() -> list:
    """Folder TypeInfos that name a main document (skill → SKILL.md) and a
    placement; a folder type without a main document has nothing to version."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    out = []
    for name in SchemaRegistry.get_all_types():
        t = SchemaRegistry.get(name)
        if t and t.main_file and t.main_subdir:
            out.append(t)
    return out


def _safe_folder_backed_types() -> list:
    """Folder-backed asset types, or ``[]`` if the registry is momentarily
    unavailable — scope resolution must never break a save or a git-ops request."""
    try:
        return _folder_backed_types()
    except Exception:  # noqa: BLE001
        logger.debug("folder-asset resolve: registry unavailable", exc_info=True)
        return []


def _subdir_match(folder: Path, main_subdir: str) -> bool:
    """True when ``folder`` sits directly under ``main_subdir`` (i.e. it is a
    ``<scope>/<main_subdir>/<name>`` asset folder) — guards against a stray
    directory that merely happens to contain a file named like a main_file."""
    parent = str(folder.parent).replace("\\", "/").rstrip("/")
    needle = main_subdir.strip("/")
    return parent == needle or parent.endswith("/" + needle)


def folder_asset_for(path: str | Path) -> tuple[Path, Path] | None:
    """If ``path`` is the folder, the main file, or an internal file of a
    folder-backed asset, return ``(asset_folder, main_file_abs)``; else ``None``.

    Walks from ``path`` outward to the nearest enclosing asset folder, so an
    internal script (``<skill>/scripts/run.py``) resolves to its skill.
    """
    types = _safe_folder_backed_types()
    if not types:
        return None
    p = Path(path)
    chain = ([p] if p.is_dir() else []) + list(p.parents)
    for anc in chain:
        for t in types:
            main = anc / t.main_file
            if main.is_file() and _subdir_match(anc, t.main_subdir):
                return anc, main
    return None


def is_folder_asset_dir(path: str | Path) -> bool:
    """True when ``path`` is itself a folder-backed asset folder (the dir the
    skill editor hands the git-ops endpoints as ``workdir``)."""
    p = Path(path)
    if not p.is_dir():
        return False
    return any(
        (p / t.main_file).is_file() and _subdir_match(p, t.main_subdir)
        for t in _safe_folder_backed_types()
    )
