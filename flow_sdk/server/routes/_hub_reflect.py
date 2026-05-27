"""Generic action-to-hub reflection.

When a local action runs against an entity that has a hub counterpart
(``entity.remote=True``), and the action is marked ``reflect="hub"`` on its
``@action`` decorator, the dispatcher forwards the call to the hub instead of
invoking the local handler. The hub's response is then mirrored into the
local row so the local cache stays consistent.

The TS SDK only ever talks to the local server; this module is the seam
that turns the local server into a transparent proxy for remote entities.
"""

from __future__ import annotations

import logging
from typing import Any

from flow_sdk.actions.action_registry import Action
from flow_sdk.cli.auth.hub_login import is_logged_in
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.utils.hub import HubError, hub_get, hub_post

logger = logging.getLogger(__name__)


def should_reflect_to_hub(a: Action, entity: Entity | None) -> bool:
    """True iff this action call should be forwarded to the hub instead of run locally."""
    return (
        getattr(a, "reflect", None) == "hub"
        and entity is not None
        and getattr(entity, "remote", False) is True
        and is_logged_in()
    )


def _entity_type_enum(entity: Entity) -> BuiltinEntityType | None:
    """Map ``entity.type`` (string) to the ``BuiltinEntityType`` enum.

    Returns None when the type isn't a builtin (e.g. plugin-defined entities)
    — those have no hub representation so reflection is a no-op.
    """
    try:
        return BuiltinEntityType(entity.type)
    except ValueError:
        return None


async def reflect_to_hub(a: Action, entity: Entity, body: dict[str, Any]) -> Any:
    """Forward the action call to the hub and mirror the response into the local row.

    Returns the hub's response payload (the unwrapped ``data`` dict/list).
    Raises ``HubError`` on failure — caller decides whether to fall through
    to the local handler.
    """
    et = _entity_type_enum(entity)
    if et is None:
        raise HubError(0, f"entity type {entity.type!r} has no hub representation")

    if "get" in a.methods:
        hub_resp = await hub_get(et, entity.id, action=a.action_name)
        # hub_get returns None on transport/HTTP failure (does not raise);
        # treat that as "fall through to local" via HubError.
        if hub_resp is None:
            raise HubError(0, "hub_get returned no data")
    else:
        hub_resp = await hub_post(et, body or {}, entity.id, action=a.action_name)

    await mirror_hub_response_into_local(entity, a.action_name, hub_resp)
    return hub_resp


async def mirror_hub_response_into_local(
    entity: Entity, action_name: str, hub_resp: Any
) -> None:
    """Write hub-provided state back into the local entity row.

    Opportunistic: only writes fields the entity already exposes. Generic
    across entity types — no per-type custom logic. Specific actions can
    extend this later if they need richer merge semantics.
    """
    if hub_resp is None:
        return

    # Generic shape: action returns a list whose entries look like
    # participants → mirror onto ``entity.participants`` if the field exists.
    if action_name == "members" and isinstance(hub_resp, list):
        if hasattr(entity, "participants"):
            try:
                entity.participants = list(hub_resp)
                # Best-effort save; never blow up the action if persistence fails.
                save = getattr(entity, "save", None)
                if callable(save):
                    await save()
            except Exception as e:  # noqa: BLE001
                logger.debug("[hub-reflect] mirror save failed for %s: %s", entity.type, e)
