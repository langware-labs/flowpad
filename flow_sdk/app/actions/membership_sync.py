"""Materialize hub-side Organization / Team rows locally as ``remote=True``.

Organizations and teams are hub-authoritative. The desktop client mirrors them
into the local store as ``remote=True`` entities at the hub id so the profile
chip, the Organization settings tab, and member lists resolve from a real local
row (and stay refreshable from the hub). Used on two paths:

  * cloud login — the login payload embeds the user's organization;
  * invitation accept — the accepted org/team becomes a local membership.

This mirrors ``_upsert_hub_conversation_metadata`` (the Conversation precedent)
but is intentionally tiny: orgs/teams have no children, projections, or
message_ids to guard, only flat metadata fields.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional, Type

from flow_sdk._compat import UTC
from flow_sdk.builtin.organization import Organization
from flow_sdk.core.entity.entity_model import Entity, remote_reflection

logger = logging.getLogger(__name__)

# Flat metadata fields we mirror from the hub payload, when present on the type.
_MIRRORED_FIELDS = ("name", "account", "domain", "icon")


async def materialize_remote_membership_entity(
    cls: Type[Entity],
    data: dict[str, Any],
    someone_typeid: str | None = None,
    *,
    notify: bool = True,
) -> Optional[Entity]:
    """Upsert a hub Organization/Team dict into the local store (``remote=True``).

    Idempotent: re-running with the same payload is a no-op when nothing
    changed. Returns the local row, or ``None`` when the payload has no id.
    """
    if not isinstance(data, dict):
        return None
    ent_id = (str(data.get("id") or "")).strip()
    if not ent_id:
        return None

    fields = tuple(k for k in _MIRRORED_FIELDS if k in cls.model_fields)
    existing = await cls.get_one({"id": ent_id})
    if existing is None:
        payload: dict[str, Any] = {"id": ent_id, "remote": True}
        for k in fields:
            if data.get(k) is not None:
                payload[k] = data[k]
        if data.get("created_date") is not None:
            payload["created_date"] = data["created_date"]
        if data.get("updated_date") is not None:
            payload["updated_date"] = data["updated_date"]
        payload["fetched_at"] = datetime.now(UTC)
        ent = cls.model_validate(payload)
        ent.id = ent_id
        # Pure reflection of the hub row — preserve created_by/dates verbatim,
        # never stamp the local sync user.
        with remote_reflection():
            return await ent.save(someone_typeid, notify=notify)

    changed = False
    for k in fields:
        v = data.get(k)
        if v is not None and getattr(existing, k, None) != v:
            setattr(existing, k, v)
            changed = True
    if not existing.remote:
        existing.remote = True
        changed = True
    if changed:
        existing.fetched_at = datetime.now(UTC)
        with remote_reflection():
            await existing.save(someone_typeid, notify=notify)
    return existing


async def materialize_remote_organization(
    data: dict[str, Any], someone_typeid: str | None = None, *, notify: bool = True
) -> Optional[Organization]:
    return await materialize_remote_membership_entity(Organization, data, someone_typeid, notify=notify)
