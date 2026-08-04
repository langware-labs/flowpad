"""Project-scoped helpdesk resolution shared by portal and ticket actions.

This module deliberately knows nothing about HTTP actions or Hub transport. It
only answers which already-indexed Helpdesk a Project adopted through its own
root or one of its direct context roots.
"""

from __future__ import annotations

from dataclasses import dataclass

from flow_sdk.builtin.helpdesk import Helpdesk
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.identifier import is_valid_entity_id
from flow_sdk.fs_store.path_utils import canonical_posix_path, is_path_under


@dataclass(frozen=True)
class AdoptedHelpdesk:
    """One locally adopted desk and the Hub queue named by its manifest."""

    portal_project_id: str
    queue_project_id: str
    mount_path: str


async def resolve_adopted_helpdesk(project_id: str) -> AdoptedHelpdesk | None:
    """Return the deterministic desk adopted by ``project_id``, if any.

    Roots are authoritative in Project order: the target root first, followed
    by direct context roots in their declared order. Within one root, Helpdesks
    are ordered by canonical asset path and then entity id, so database row
    order can never change which Hub queue receives a ticket.

    Resolution is read-only. A context root whose Project projection has not
    been indexed yet is skipped rather than minted on an open/ticket path.
    """
    project = await Project.get_by_id(project_id)
    if project is None:
        return None

    roots = project.direct_context_roots()
    if not roots:
        return None

    desks = sorted(
        (desk for desk in await Helpdesk.get_all() if desk.asset_ref),
        key=lambda desk: (canonical_posix_path(desk.asset_ref), str(desk.id)),
    )
    projects_by_mount = await Project.index_by_mount()

    for root in roots:
        portal = projects_by_mount.get(root)
        if portal is None:
            continue
        for desk in desks:
            if not is_path_under(canonical_posix_path(desk.asset_ref), root):
                continue
            queue_id = desk.desk_project_id
            if not isinstance(queue_id, str):
                continue
            queue_id = queue_id.strip()
            if not is_valid_entity_id(queue_id):
                continue
            return AdoptedHelpdesk(
                portal_project_id=str(portal.id),
                queue_project_id=queue_id,
                mount_path=root,
            )
    return None
