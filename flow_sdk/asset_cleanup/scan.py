"""Scan-root discovery for the asset-cleanup flow.

A scan root is a directory whose ``.claude/skills`` / ``.claude/agents``
children the ``asset_cleanup`` agent inventories. The default set is the user
home plus the fs mount of every project active within the recency window.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from pathlib import Path

from flow_sdk.instance_settings import get_instance_settings

_log = logging.getLogger(__name__)


async def collect_scan_roots(hours: int = 24, projects: list | None = None) -> list[Path]:
    """Return the user home + mounts of projects active in the last ``hours``.

    "Active" means either ``last_active_at`` (epoch-ms open/activate stamp) or
    ``last_session_at`` (indexer-denormalized ISO timestamp of the newest
    session at the project cwd) falls within the window. Missing/unparseable
    timestamps count as inactive. Pass ``projects`` to reuse an already-fetched
    ``Project.get_all()`` (the default path fetches once and shares it with
    :func:`collect_project_inventory`).
    """
    if projects is None:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415
        projects = await Project.get_all()

    roots: list[Path] = [Path(get_instance_settings().user_home)]
    cutoff = datetime.now().astimezone() - timedelta(hours=hours)
    cutoff_ms = int(cutoff.timestamp() * 1000)

    for project in projects:
        mount = project.fs_storage_mount_path
        if not mount:
            continue
        if not _is_active(project, cutoff, cutoff_ms):
            continue
        path = Path(mount)
        if path.is_dir() and path not in roots:
            roots.append(path)
    return roots


async def collect_project_inventory(projects: list | None = None) -> list[dict]:
    """Compact inventory of ALL user projects for junk-project classification.

    Deliberately not limited to the recency window — staleness is a garbage
    signal for projects, not an exclusion. Skips the @local singleton project
    and projects without an existing mount folder. Pass ``projects`` to reuse
    an already-fetched ``Project.get_all()``.
    """
    if projects is None:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415
        projects = await Project.get_all()

    home = str(Path(get_instance_settings().user_home))
    out: list[dict] = []
    for project in projects:
        mount = project.fs_storage_mount_path
        if not mount or not Path(mount).is_dir():
            continue
        # Never offer the home dir or the @local singleton for cleanup.
        if getattr(project, "uname", None) == "local" or str(Path(mount)) == home:
            continue
        out.append({
            "id": project.id,
            "name": project.name,
            "path": str(Path(mount)),
            "last_session_at": project.last_session_at,
            "session_count": project.session_count,
        })
    return out


def _is_active(project, cutoff: datetime, cutoff_ms: int) -> bool:
    if project.last_active_at and project.last_active_at >= cutoff_ms:
        return True
    if project.last_session_at:
        try:
            ts = datetime.fromisoformat(project.last_session_at)
        except ValueError:
            return False
        if ts.tzinfo is None:
            ts = ts.astimezone()
        return ts >= cutoff
    return False
