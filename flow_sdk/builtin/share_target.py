"""Which of the receiver's projects a shared asset opens in.

One rule, in order:
1. the conversation is already bound to a project → that project;
2. the sender's project maps to one of ours (``project_mapping.json``) → that;
3. our projects that are checkouts of the shared repo → the one, or ask once.

The answer the receiver gives is saved (the conversation's project, and the
sender's project → ours), so the question never comes back. When 1/2 name a
project that is not a checkout of the shared repo while another project is,
that is a ``mismatch`` the receiver is warned about.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class ShareTarget:
    """The decision. ``project_id`` set = open there; else ``candidates`` (2+:
    ask once) or none (ask: clone, or open the copy)."""

    project_id: str | None
    candidates: list[dict] = field(default_factory=list)
    mismatch: bool = False


def is_checkout_of(origin, folder: Path | None) -> bool:
    """Whether ``folder`` sits in a checkout of ``origin``'s repo. Blocking."""
    from flow_sdk.utils.git import find_project_root  # noqa: PLC0415

    matches = getattr(origin, "matches_checkout", None)
    if folder is None or not callable(matches) or not folder.is_dir():
        return False
    root = find_project_root(str(folder))
    return bool(root) and matches(Path(root))


def _mount(project) -> Path | None:
    mount = (getattr(project, "fs_storage_mount_path", "") or "").strip()
    return Path(mount) if mount else None


async def projects_checking_out(origin) -> list:
    """This instance's projects whose folder is a checkout of ``origin``'s repo."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    projects = await Project.get_all()
    hits = await asyncio.gather(*(asyncio.to_thread(is_checkout_of, origin, _mount(p)) for p in projects))
    return [p for p, hit in zip(projects, hits) if hit]


def project_for_sender(remote_project_id: str | None) -> str | None:
    """Our project chosen for the sender's project, if any."""
    from flow_sdk.app.actions.notification_action import _load_project_mapping  # noqa: PLC0415

    return _load_project_mapping().get(remote_project_id) if remote_project_id else None


def remember_project_for_sender(remote_project_id: str | None, project_id: str) -> None:
    """Keep ``project_id`` as ours for the sender's project."""
    from flow_sdk.app.actions.notification_action import (  # noqa: PLC0415
        _load_project_mapping,
        _save_project_mapping,
    )

    if not remote_project_id:
        return
    mapping = _load_project_mapping()
    if mapping.get(remote_project_id) != project_id:
        _save_project_mapping({**mapping, remote_project_id: project_id})


async def resolve_share_target(origin, *, bound_project_id: str | None, remote_project_id: str | None) -> ShareTarget:
    """Pick the receiver's project for a share of ``origin``."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    named = bound_project_id or project_for_sender(remote_project_id)
    if named:
        project = await Project.get_one({"id": named})
        if await asyncio.to_thread(is_checkout_of, origin, _mount(project)):
            return ShareTarget(project_id=named)
        # Named but not a checkout: a mismatch only when another project is one.
        return ShareTarget(project_id=named, mismatch=bool(await projects_checking_out(origin)))
    checkouts = await projects_checking_out(origin)
    if len(checkouts) == 1:
        return ShareTarget(project_id=checkouts[0].id)
    return ShareTarget(
        project_id=None,
        candidates=[
            {"id": p.id, "name": getattr(p, "displayName", None) or p.name, "path": p.fs_storage_mount_path}
            for p in checkouts
        ],
    )


async def clone_as_project(origin):
    """Clone ``origin``'s repo into the workspace (with the user's GitHub token,
    like every other clone of a shared repo) and open it as a project."""
    from flow_sdk.app.actions.oauth_action import _get_github_token_for_current_user  # noqa: PLC0415
    from flow_sdk.builtin.drivers.git_driver import _HUMAN, GitShareError, _clone_failure_code  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.utils.git import git_clone  # noqa: PLC0415

    target = await asyncio.to_thread(origin.next_clone_target)
    if not (target.exists() and any(target.iterdir())):
        token = await _get_github_token_for_current_user()
        cloned = await git_clone(origin.clone_url(), str(target), branch=origin.branch or None, token=token)
        if not cloned.ok:
            code = _clone_failure_code(cloned.detail)
            raise GitShareError(code, _HUMAN.get(code) or cloned.detail)
    project = await Project.recover_by_path(str(target))
    if project is None:
        raise GitShareError("git-failed", f"could not open {target} as a project")
    return project
