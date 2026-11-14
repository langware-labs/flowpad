"""``context-relations`` — an entity's context in both directions, ready to list.

    GET /api/v1/graph/{type}/{id}/context-relations

Reads the ``context`` relationship rows (``db/drivers/sqlite/context_mirror.py`` keeps them in
step with the entity's lists and declared context fields) plus the entity's computed private
context (its project, a session's shell), which is stored nowhere. One row per peer, newest first.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime

from flow_sdk.actions import action
from flow_sdk.app.actions.context_share_action import _resolve_target_entity
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.db.drivers.sqlite.context_mirror import CONTEXT_TYPE
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.context_relation_spec import ContextRelationSpec

LIMIT = 100


@dataclass
class _Peer:
    typeid: TypeId
    directions: set[str] = field(default_factory=set)
    kinds: list[str] = field(default_factory=list)
    role: str = ""
    when: datetime | None = None

    def note(self, direction: str, kind: str, role: str, when: datetime | None) -> None:
        self.directions.add(direction)
        if kind and kind not in self.kinds:
            self.kinds.append(kind)
        self.role = self.role or role
        if when is not None and (self.when is None or when > self.when):
            self.when = when


def display_name(entity: Entity) -> str:
    """What a row calls an entity: its own display name or title when it has one (a
    conversation's or a task's ``name`` is a generated key), else its summary name, else the
    first thing that names it. ``""`` when nothing does."""
    try:
        summary = entity.tooltip_summary().get("name")
    except Exception:
        summary = None
    named = (getattr(entity, "display_name", None), getattr(entity, "title", None), summary, entity.name, entity.uname)
    for candidate in named:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    # A message has no name: its subject, else how its text begins.
    for candidate in (getattr(entity, "subject", None), getattr(entity, "text", None)):
        if isinstance(candidate, str) and candidate.strip():
            line = candidate.strip().splitlines()[0]
            return line if len(line) <= 60 else line[:59] + "…"
    return ""


async def context_relations(entity: Entity) -> list[ContextRelationSpec]:
    """One row per peer of ``entity``'s context. A peer that is gone is left out."""
    match = QueryFilter.parse({"type": CONTEXT_TYPE})
    outgoing, incoming = await asyncio.gather(
        entity.get_outgoing_relationships(match), entity.get_incoming_relationships(match)
    )
    peers: dict[str, _Peer] = {}

    def peer(typeid: TypeId) -> _Peer:
        return peers.setdefault(str(typeid), _Peer(typeid))

    for rel in outgoing:
        peer(rel.to_typeid).note("out", rel.kind, rel.role, rel.created_date)
    for rel in incoming:
        peer(rel.from_typeid).note("in", rel.kind, rel.role, rel.created_date)
    for typeid in entity.get_implicit_private_context_entities():
        if str(typeid) not in peers and str(typeid.id) != str(entity.id):  # a project is its own project
            peer(typeid).note("out", "private", "", entity.created_date)

    newest = sorted(peers.values(), key=lambda p: p.when.timestamp() if p.when else 0.0, reverse=True)[:LIMIT]
    targets = await asyncio.gather(*(Entity.load_by_type(p.typeid.type, str(p.typeid.id)) for p in newest))
    return [
        ContextRelationSpec(
            direction="both" if len(p.directions) == 2 else next(iter(p.directions)),
            typeid=str(p.typeid), type=p.typeid.type, name=display_name(target),
            kind=",".join(p.kinds), role=p.role, time=p.when.isoformat() if p.when else "",
        )
        for p, target in zip(newest, targets)
        if target is not None
    ]


@action.get(action_name="context-relations", types="all")
async def context_relations_action() -> ApiResponse:
    entity = await _resolve_target_entity()
    return ApiSuccessResponse(data=[row.model_dump() for row in await context_relations(entity)])
