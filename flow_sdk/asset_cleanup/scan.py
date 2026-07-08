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


async def collect_scan_roots(hours: int = 24) -> list[Path]:
    """Return the user home + mounts of projects active in the last ``hours``.

    "Active" means either ``last_active_at`` (epoch-ms open/activate stamp) or
    ``last_session_at`` (indexer-denormalized ISO timestamp of the newest
    session at the project cwd) falls within the window. Missing/unparseable
    timestamps count as inactive.
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    roots: list[Path] = [Path(get_instance_settings().user_home)]
    cutoff = datetime.now().astimezone() - timedelta(hours=hours)
    cutoff_ms = int(cutoff.timestamp() * 1000)

    for project in await Project.get_all():
        mount = project.fs_storage_mount_path
        if not mount:
            continue
        if not _is_active(project, cutoff, cutoff_ms):
            continue
        path = Path(mount)
        if path.is_dir() and path not in roots:
            roots.append(path)
    return roots


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
