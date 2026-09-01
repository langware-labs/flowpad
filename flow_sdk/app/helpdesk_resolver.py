"""Project-scoped helpdesk resolution shared by portal and ticket actions.

This module deliberately knows nothing about HTTP actions or Hub transport. It
only answers which already-indexed Helpdesk a Project adopted through its own
root or one of its direct context roots.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from flow_sdk.builtin.helpdesk import Helpdesk
from flow_sdk.builtin.project import Project
from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.fs_store.path_utils import canonical_posix_path, is_path_under

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class AdoptedHelpdesk:
    """One locally adopted desk and the Hub queue named by its manifest.

    ``portal_project_id`` is None when the desk's folder has not (yet) been
    indexed as a Project of its own. That is a presentation detail — it is what
    lets the UI open the portal's project home — and it deliberately does NOT
    gate resolution: the queue a ticket routes to is named by the manifest, not
    by whether the checkout happens to have a Project projection.
    """

    portal_project_id: str | None
    queue_project_id: str
    mount_path: str


async def resolve_adopted_helpdesk(project_id: str) -> AdoptedHelpdesk | None:
    """Return the deterministic desk adopted by ``project_id``, if any.

    Roots are authoritative in Project order: the target root first, followed
    by direct context roots in their declared order. Within one root, Helpdesks
    are ordered by canonical asset path and then entity id, so database row
    order can never change which Hub queue receives a ticket.

    Resolution is read-only — a context root whose Project projection has not
    been indexed yet is never minted here, on an open/ticket path.

    It is not SKIPPED either, which it used to be. A desk attached by path
    rather than through the git flow has no Project of its own, and requiring
    one made resolution return None: the ticket then fell through to the hub's
    default desk, silently, with no error anywhere. Routing a customer's
    support request to a different company than the one whose desk they
    adopted is the worst failure this module has, so the Project projection is
    now carried when present and simply absent when not.
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
        for desk in desks:
            if not is_path_under(canonical_posix_path(desk.asset_ref), root):
                continue
            queue_id = desk.desk_project_id
            queue_id = queue_id.strip() if isinstance(queue_id, str) else ""
            if not is_valid_entity_id(queue_id):
                # A desk asset IS adopted here but names no usable queue. Say so:
                # the caller is about to fall through to the hub's default desk,
                # i.e. send this ticket to somebody else, and a silent fallback
                # is indistinguishable from "no desk adopted".
                log.warning(
                    "[helpdesk] adopted desk at %s names no valid desk_project_id (%r) — "
                    "ticket routing will fall through to the default desk",
                    desk.asset_ref,
                    queue_id,
                )
                continue
            return AdoptedHelpdesk(
                portal_project_id=str(portal.id) if portal is not None else None,
                queue_project_id=queue_id,
                mount_path=root,
            )
    return None
