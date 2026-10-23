"""Materialize hub-side membership-container rows locally as ``remote=True``.

Organizations, teams, and projects are hub-authoritative once shared. The
desktop client mirrors them into the local store as ``remote=True`` entities at
the hub id so local surfaces resolve from a real row (and stay refreshable from
the hub). Used on three paths:

  * cloud login — the login payload embeds the user's organization;
  * invitation accept — the accepted org/team becomes a local membership.
  * live assignment — the Hub pushes the granted container to the recipient.

Every path lands the row through the one hub mirror (``Entity.mirror_from_hub``), the same one
conversations use: the type's declarations say which fields come from the hub.
"""

from __future__ import annotations

import logging
from typing import Any, Optional, Type

from flow_sdk.builtin.organization import Organization
from flow_sdk.core.entity.entity_model import Entity, mirror_delete
from flow_sdk.schema.types import MEMBERSHIP_CONTAINER_TYPES

logger = logging.getLogger(__name__)


# The membership containers whose full Hub payload can be mirrored directly.
# Keep this set shared by invitation previews and live assignment ingest so a
# newly supported container cannot silently work on only one receive path.
MEMBERSHIP_MIRROR_TYPES: frozenset[str] = MEMBERSHIP_CONTAINER_TYPES


async def materialize_remote_membership_entity(
    cls: Type[Entity],
    data: dict[str, Any],
    someone_typeid: str | None = None,
    *,
    notify: bool = True,
) -> Optional[Entity]:
    """Land a hub membership container (organization, team, linked project) here as ``remote``.

    The one mirror (``Entity.mirror_from_hub``): the fields the type takes from the hub, by its
    declarations. Organizations and teams exist only on the hub; a project is local until it is
    linked, and only then does the hub's row reach it. Idempotent; ``None`` when the row has no id.
    """
    if not isinstance(data, dict):
        return None
    return await cls.mirror_from_hub(data, someone_typeid, notify=notify)


async def materialize_remote_organization(
    data: dict[str, Any], someone_typeid: str | None = None, *, notify: bool = True
) -> Optional[Organization]:
    return await materialize_remote_membership_entity(Organization, data, someone_typeid, notify=notify)


async def sync_remote_memberships(someone_typeid: str | None = None) -> int:
    """Bring this box's organizations and teams in line with the hub's list for the signed-in user.

    A container otherwise reaches the desk only through a live membership push (or, for one
    organization, the login payload), and the hub never replays one — an organization created on the
    web or while this box was offline never arrives. Removal is pushed by no one either, so a row the
    hub no longer lists (the user was removed, or it was deleted) is dropped here. Only when the hub
    answered: an unreachable hub keeps every row. The catch-up transitions call this. Returns the
    number of rows mirrored.
    """
    from flow_sdk.builtin.team import Team  # noqa: PLC0415
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import rows_of  # noqa: PLC0415

    mirrored = 0
    for cls in (Organization, Team):
        try:
            rows = rows_of(await HubProxy.call("GET", cls.get_type(), params={"limit": 1000}))
        except HubError as exc:
            logger.info("[membership-sync] %s list unavailable, keeping local rows: %s", cls.get_type(), exc)
            continue
        listed = {str(row.get("id")) for row in rows if isinstance(row, dict) and row.get("id")}
        for row in rows:
            if await materialize_remote_membership_entity(cls, row, someone_typeid, notify=True) is not None:
                mirrored += 1
        for local in await cls.get_all({"remote": True}):
            if local.id and str(local.id) not in listed:
                with mirror_delete():  # only this box's copy — the hub row is not ours to delete
                    await cls.delete_by_id(local.id)
    return mirrored
