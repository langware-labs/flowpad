"""Where this code runs: the project of the working directory.

    project = await context.current_project()

The same answer for a worker, a terminal and a script: the project whose folder contains the
working directory, nearest folder first. ``None`` outside every project — and always ``None`` in
the backend server: its working directory is wherever it was launched (a dev checkout), not a project
its background work belongs to.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from flow_sdk.builtin.project import Project


_IN_SERVER = False


def mark_server_process() -> None:
    """This process is the backend server: its working directory names no project."""
    global _IN_SERVER
    _IN_SERVER = True


async def current_project(cwd: Optional[str] = None) -> Optional["Project"]:
    """The project whose mount holds ``cwd`` (default: the working directory), or ``None``.

    Asks the indexed mount lookup once per ancestor folder; it never scans every project.
    """
    if cwd is None and _IN_SERVER:
        return None
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import canonical_posix_path, is_valid_project_cwd  # noqa: PLC0415

    # Canonicalized once: the parents of a resolved path are already canonical.
    start = Path(canonical_posix_path(cwd or os.getcwd()))
    for folder in (start, *start.parents):
        if not is_valid_project_cwd(str(folder), include_temp=True):
            continue
        owners = await Project._mount_owners(folder.as_posix())
        if owners:
            return owners[0]
    return None


__all__ = ["current_project", "mark_server_process"]
