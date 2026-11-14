"""Context relationship rows — the mirror of an entity's context, kept in step at save.

An entity's context is its two lists (``shared_context_entities``, ``private_context_entities_``)
plus any field its type declares in ``context_fields`` (a process's target, a frozen context's members). Those stay the
source of truth. On every save the driver hands the row's stored data and the data about to be
written to ``sync_context_rows``: unchanged context costs no SQL; changed context reads this
entity's outgoing ``context`` rows once and inserts / deletes / re-roles only what differs, so an
entry that stays keeps its ``created_date``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime

from sqlalchemy import select

from flow_sdk.api.api_types.identifier import is_valid_uuid, mint_uuid
from flow_sdk.db.drivers.sqlite.connection import RelationshipSchema
from flow_sdk.flowpad_types.enums import BuiltInRelationshipTypes
from flow_sdk.fs_store.type_id import TypeId

CONTEXT_TYPE = BuiltInRelationshipTypes.Context.value

#: list field -> (kind, side-data field holding each entry's role)
CONTEXT_LISTS: dict[str, tuple[str, str]] = {
    "shared_context_entities": ("shared", "shared_context_entity_data"),
    "private_context_entities_": ("private", "private_context_entity_data"),
}

Entries = dict[tuple[str, str, str], str]  # (to_type, to_id, kind) -> role


def _typeid_of(ref: object, *, entity_only: bool = False) -> TypeId | None:
    """A stored reference as a TypeId: the object, its ``type-id`` string or its dict form.

    ``entity_only`` is for a declared context field, whose value may also be a path, a surface
    key or a synthetic id (``claude_session/<sid>``, ``capability-<kind>``): those name no
    entity and get no row."""
    if isinstance(ref, TypeId):
        tid = ref
    elif isinstance(ref, dict) and ref.get("type") and ref.get("id"):
        tid = TypeId(type=ref["type"], id=ref["id"])
    elif isinstance(ref, str) and TypeId.is_typeid(ref):
        tid = TypeId(ref)
    else:
        return None
    if entity_only:
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        if not is_valid_uuid(str(tid.id)) or SchemaRegistry.get_entity_cls(tid.type) is None:
            return None
    return tid


def _holds_no_context(raw: str, declared: Mapping[str, str]) -> bool:
    """True when stored entity JSON plainly holds no context — every context field absent or
    empty — so the caller can skip parsing it. Most saves are of such an entity."""
    for field in (*CONTEXT_LISTS, *declared):
        key = f'"{field}": '
        at = raw.find(key)
        while at != -1:  # every occurrence: the same key may sit in nested data too
            if not raw.startswith(("[]", "null", '""'), at + len(key)):
                return False
            at = raw.find(key, at + len(key))
    return True


def context_entries(data: Mapping | str | None, declared: Mapping[str, str]) -> Entries:
    """Every context entry the entity data holds, keyed by what it points at and how.
    ``data`` is the entity's data dict, or its stored JSON (parsed only when it holds context)."""
    out: Entries = {}
    if isinstance(data, str):
        data = None if _holds_no_context(data, declared) else json.loads(data)
    if not data:
        return out
    for field, (kind, side) in CONTEXT_LISTS.items():
        roles = data.get(side) or {}
        for ref in data.get(field) or []:
            tid = _typeid_of(ref)
            if tid is not None:
                entry = roles.get(str(tid)) if isinstance(roles, Mapping) else None
                role = entry.get("role") if isinstance(entry, Mapping) else None
                out[(tid.type, str(tid.id), kind)] = str(role or "")
    for field, declaration in declared.items():
        # ``kind`` for a field holding ``<type>-<id>`` references; ``kind:<type>`` for one holding bare ids.
        kind, _, id_type = declaration.partition(":")
        value = data.get(field)
        for ref in value if isinstance(value, list) else [value]:
            if id_type and isinstance(ref, str) and is_valid_uuid(ref):
                tid = TypeId(type=id_type, id=ref)
            else:
                tid = _typeid_of(ref, entity_only=True)
            if tid is not None:
                out[(tid.type, str(tid.id), kind)] = ""
    return out


async def sync_context_rows(session, entity, stored: str | None, new_data: Mapping | str | None) -> None:
    """Bring ``entity``'s outgoing context rows in step with ``new_data`` (same session as the save).
    ``stored`` is the row's data JSON before this save, ``None`` for a new row.

    Writes ``RelationshipSchema`` rows directly, not through the relationship API: they must share
    the save's own transaction. Nothing caches these rows, so no cache is invalidated here."""
    declared = getattr(type(entity), "context_fields", None) or {}
    wanted = context_entries(new_data, declared)
    if wanted == context_entries(stored, declared):
        return
    from_type, from_id = (entity.type or entity.get_type()).lower(), str(entity.id)
    wanted = {key: role for key, role in wanted.items() if key[1] != from_id}
    rows = (
        await session.execute(
            select(RelationshipSchema).where(RelationshipSchema.from_id == from_id, RelationshipSchema.type == CONTEXT_TYPE)
        )
    ).scalars().all()
    have = {(row.to_type, row.to_id, (json.loads(row.data) if row.data else {}).get("kind", "")): row for row in rows}
    now = datetime.now(UTC)
    by = getattr(entity, "updated_by", None) or getattr(entity, "created_by", None)
    for (to_type, to_id, kind), role in wanted.items():
        held = have.pop((to_type, to_id, kind), None)
        if held is None:
            session.add(RelationshipSchema(
                id=mint_uuid(), type=CONTEXT_TYPE, from_id=from_id, from_type=from_type, to_id=to_id, to_type=to_type,
                created_by=by, created_date=now, updated_by=by, updated_date=now, is_child=False, is_final=False,
                data=json.dumps({"kind": kind, "role": role}),
            ))
        elif (extra := json.loads(held.data) if held.data else {}).get("role", "") != role:
            held.data, held.updated_date, held.updated_by = json.dumps({**extra, "role": role}), now, by
    for row in have.values():
        await session.delete(row)
