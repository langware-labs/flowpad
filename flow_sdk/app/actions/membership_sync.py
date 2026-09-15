"""Materialize hub-side membership-container rows locally as ``remote=True``.

Organizations, teams, and projects are hub-authoritative once shared. The
desktop client mirrors them into the local store as ``remote=True`` entities at
the hub id so local surfaces resolve from a real row (and stay refreshable from
the hub). Used on three paths:

  * cloud login — the login payload embeds the user's organization;
  * invitation accept — the accepted org/team becomes a local membership.
  * live assignment — the Hub pushes the granted container to the recipient.

This mirrors ``_upsert_hub_conversation_metadata`` (the Conversation precedent)
but keeps container-specific expansion here: organizations and teams need only
flat metadata, while projects additionally materialize their shared Folder
references.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional, Type

from pydantic import TypeAdapter

from flow_sdk._compat import UTC
from flow_sdk.builtin.organization import Organization
from flow_sdk.core.entity.entity_model import Entity, remote_reflection
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.serializer.hub import HubSerializer
from flow_sdk.fs_store.type_id import TypeId

logger = logging.getLogger(__name__)


# The membership containers whose full Hub payload can be mirrored directly.
# Keep this set shared by invitation previews and live assignment ingest so a
# newly supported container cannot silently work on only one receive path.
MEMBERSHIP_MIRROR_TYPES: frozenset[str] = frozenset(
    {
        BuiltinEntityType.ORGANIZATION.value,
        BuiltinEntityType.TEAM.value,
        BuiltinEntityType.PROJECT.value,
    }
)

# Flat metadata fields we mirror from the hub payload, when present on the type.
# ``name`` AND ``title`` both ride: every entity carries both slots on both
# sides now, so whichever one the type authors arrives verbatim. There is no
# title→name coercion here — a project's label is ``name`` on the hub too.
_MIRRORED_FIELDS = (
    "name",
    "title",
    "origin",
    "helpdesk",
    "account",
    "domain",
    "icon",
    # The language a project is worked in: a property of the WORK, so a
    # recipient — a person accepting an invitation, or the box behind a sandbox
    # handover — opens it in the language its author chose instead of falling
    # back to English. (Per-device UI state like ``last_mode`` deliberately does
    # not travel and must not be added here.)
    "locale",
    "members",
    "shared_context_entities",
    "shared_context_origins",
)


_FIELD_ADAPTERS: dict[tuple[type, str], Any] = {}


def _validated_field(cls: Type[Entity], name: str, value: Any) -> Any:
    """Coerce a raw hub value into the target field's declared type.

    The create path gets this free from ``cls.model_validate``; the update path
    used to ``setattr`` raw JSON, so a typed field (e.g. ``Project.origin``)
    ended up holding a dict and every consumer had to re-check. Validate here,
    at the mirror boundary, and fall back to the raw value if it doesn't fit.
    """
    if value is None:
        return None
    key = (cls, name)
    adapter = _FIELD_ADAPTERS.get(key)
    if adapter is None:
        adapter = _FIELD_ADAPTERS[key] = TypeAdapter(cls.model_fields[name].annotation)
    try:
        return adapter.validate_python(value)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[membership-sync] %s.%s did not validate: %s", cls.__name__, name, exc)
        return value


async def materialize_remote_membership_entity(
    cls: Type[Entity],
    data: dict[str, Any],
    someone_typeid: str | None = None,
    *,
    notify: bool = True,
) -> Optional[Entity]:
    """Upsert a Hub membership-container dict locally (``remote=True``).

    Idempotent: re-running with the same payload is a no-op when nothing
    changed. Returns the local row, or ``None`` when the payload has no id.
    """
    if not isinstance(data, dict):
        return None
    ent_id = (str(data.get("id") or "")).strip()
    if not ent_id:
        return None

    data = HubSerializer.unwire(cls, data)   # the hub's wire names → field names
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
            ent = await ent.save(someone_typeid, notify=notify)
        await materialize_project_context_folders(ent, data, someone_typeid, notify=notify)
        return ent

    changed = False
    for k in fields:
        v = _validated_field(cls, k, data.get(k))
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
    await materialize_project_context_folders(existing, data, someone_typeid, notify=notify)
    return existing


async def materialize_remote_organization(
    data: dict[str, Any], someone_typeid: str | None = None, *, notify: bool = True
) -> Optional[Organization]:
    return await materialize_remote_membership_entity(Organization, data, someone_typeid, notify=notify)


async def materialize_project_context_folders(
    project: Entity,
    data: dict[str, Any],
    someone_typeid: str | None = None,
    *,
    notify: bool = True,
) -> int:
    """Materialize received project shared context Folder refs.

    Accept never clones. It creates remote Folder rows from the transportable
    origin map and links them with empty sidecars; project-open lazy resolve
    later stamps receiver-local paths.
    """
    if getattr(project, "type", None) != "project" or not isinstance(data, dict):
        return 0
    raw_refs = data.get("shared_context_entities") or []
    raw_origins = data.get("shared_context_origins") or getattr(project, "shared_context_origins", None) or {}
    if not isinstance(raw_refs, list) or not isinstance(raw_origins, dict):
        return 0

    from flow_sdk.builtin.folder import Folder  # noqa: PLC0415
    from flow_sdk.fs_store.origin.field import ORIGIN_ADAPTER  # noqa: PLC0415

    changed = False
    count = 0
    for raw_ref in raw_refs:
        try:
            tid = TypeId.to_typeid(raw_ref)
        except Exception:
            continue
        if tid.type != "folder":
            continue
        raw_origin = raw_origins.get(str(tid)) or (raw_origins.get(tid.id) if tid.id else None)
        if raw_origin is None:
            continue
        try:
            origin = ORIGIN_ADAPTER.validate_python(raw_origin)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[membership-sync] invalid shared context origin for %s: %s", tid, exc)
            continue
        if not origin.transportable:
            continue
        folder = await Folder.mint_for_origin(origin)
        folder_changed = False
        if folder.origin is None:
            folder.origin = origin
            folder_changed = True
        if not folder.remote:
            folder.remote = True
            folder_changed = True
        if folder_changed:
            with remote_reflection():
                await folder.save(someone_typeid, notify=notify)
        changed = project.add_shared_context_entities(folder.typeid) or changed
        count += 1

    if getattr(project, "shared_context_origins", None) != raw_origins and hasattr(project, "shared_context_origins"):
        setattr(project, "shared_context_origins", dict(raw_origins))
        changed = True
    if changed:
        project.fetched_at = datetime.now(UTC)
        with remote_reflection():
            await project.save(someone_typeid, notify=notify)
    return count
