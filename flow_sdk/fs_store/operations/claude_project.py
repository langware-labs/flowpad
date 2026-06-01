"""Operations on PROJECT records — mutations that used to live as classmethods
on the deleted ``ProjectFsRecord`` subclass."""

from __future__ import annotations

import shutil
from pathlib import Path

from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.indexer.functions.claude_projects import (
    _claude_projects_dir,
    _is_valid_mount_path,
    _is_valid_project_dir,
)


def _read_meta_field(record_dir: Path, key: str) -> str | None:
    """Read a field from metadata.json (data block) or state.json (meta block)."""
    import json  # noqa: PLC0415
    for filename, top_key in (("metadata.json", "data"), ("state.json", "meta")):
        f = record_dir / filename
        if f.exists():
            try:
                obj = json.loads(f.read_text())
                return obj.get(top_key, {}).get(key)
            except Exception:
                pass
    return None


def _read_mount_path(record_dir: Path) -> str | None:
    return _read_meta_field(record_dir, "fs_storage_mount_path")


def _read_cwd(record_dir: Path) -> str | None:
    return _read_meta_field(record_dir, "cwd")


async def clean_temp_projects() -> int:
    """Remove records pointing at temp paths from both records_root and the
    Claude on-disk encoded-name dirs (best-effort cleanup of stale data).

    Replaces ``ProjectFsRecord.clean_temp_projects``. Returns total dirs removed.
    """
    removed = 0

    from flow_sdk.fs_store.record_paths import get_default_records_root  # noqa: PLC0415
    records_project_dir = get_default_records_root() / RecordType.PROJECT
    if records_project_dir.is_dir():
        for d in list(records_project_dir.iterdir()):
            if not d.is_dir():
                continue
            mount_path = _read_mount_path(d) or _read_cwd(d)
            if mount_path and not _is_valid_mount_path(mount_path):
                # Just remove the shadow folder. Entity row cleanup happens
                # via the Entity API path; here we only handle disk hygiene.
                shutil.rmtree(d, ignore_errors=True)
                removed += 1

    projects_dir = _claude_projects_dir()
    if projects_dir.is_dir():
        for d in list(projects_dir.iterdir()):
            if d.is_dir() and not _is_valid_project_dir(d):
                shutil.rmtree(d, ignore_errors=True)
                removed += 1

    return removed
