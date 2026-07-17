"""Topic — a dot-path named channel in the flow graph.

DB-only entity (no ``asset_ref``, no disk record — never swept by the orphan
logic). Identity is deterministic: ``id = mint_uuid("topic:<name>")`` so the
same topic name always resolves to the same entity, on every instance. Topics
form a prefix tree by name (``a.b.c`` is a child of ``a.b``); FlowManager mints
missing ancestors lazily on first emit.

Grammar: ``seg(.seg)*`` where a segment is ``[a-z0-9_-]+`` — dots are strictly
delimiters. Matching is prefix-at-any-depth: a listener on ``a.b`` hears the
whole ``a.b.*`` subtree (see ``flow_sdk/flow_manager/matcher.py``).
"""
from __future__ import annotations

import re
from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

TOPIC_SEGMENT_RE = re.compile(r"^[a-z0-9_-]+$")


def is_valid_topic_name(name: str) -> bool:
    """True iff ``name`` is a well-formed dot-path (``seg(.seg)*``)."""
    if not name or not isinstance(name, str):
        return False
    return all(TOPIC_SEGMENT_RE.match(seg) for seg in name.split("."))


def topic_entity_id(name: str) -> str:
    """Deterministic entity id for a topic name (uuid5, type-prefixed key)."""
    return mint_uuid(f"topic:{name}")


class Topic(Entity):
    type: str = APIField(default=EntityType.TOPIC.value)
    name: str = APIField("", description="Dot-path topic name, e.g. 'report.usage.ready'.")
    description: Optional[str] = APIField(None)
    color: Optional[str] = APIField(None, description="Optional hex color for UI rendering.")

    _api_visible: ClassVar[bool] = True

    @property
    def parent_name(self) -> Optional[str]:
        """The prefix one level up (``a.b`` for ``a.b.c``), or None at a root."""
        if "." not in (self.name or ""):
            return None
        return self.name.rsplit(".", 1)[0]

    @classmethod
    async def get_or_mint(cls, name: str, scope: Optional[str] = None) -> "Topic":
        """Resolve the Topic entity for ``name``, creating it (and nothing else)
        if absent. Deterministic id makes this idempotent across callers."""
        if not is_valid_topic_name(name):
            raise ValueError(f"Invalid topic name: {name!r}")
        tid = topic_entity_id(name)
        existing = await cls.get_by_id(tid)
        if existing:
            return existing
        topic = cls(id=tid, name=name)
        if scope:
            topic.scope = scope
        await topic.save()
        return topic
