"""What each kind of row puts in context when something depends on it — bound onto ``TypeInfo``
(``dependency_roots_fn``) by ``core/asset_type_bindings.py``. A type not named here is a folder
asset (its own folder) or a single-file asset (nothing)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.dependencies.resolve import DependencyRoots, default_roots


async def project_roots(row: Any) -> DependencyRoots:
    """A project is its mount, and its root ``flow.json`` says what it depends on."""
    mount = getattr(row, "fs_storage_mount_path", None)
    return DependencyRoots(context=mount, declares=mount, project_root=True)


async def data_source_roots(row: Any) -> DependencyRoots:
    """A file source puts its FILES in context — the folder it watches, or the one it downloads
    into — while its own folder holds the ``flow.json``. A record source has no files to add."""
    roots = await default_roots(row)
    files = getattr(row, "files_root", None)
    return DependencyRoots(context=files if files and Path(files).is_dir() else None, declares=roots.declares)


async def folder_roots(row: Any) -> DependencyRoots:
    path = getattr(row, "path", None)
    path = path if path and Path(path).is_dir() else None
    return DependencyRoots(context=path, declares=path)


__all__ = ["data_source_roots", "folder_roots", "project_roots"]
