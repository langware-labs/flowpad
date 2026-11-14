"""``ContextRelationSpec`` — one row of an entity's context, as the Context menu lists it.

An entity's context has two directions: what it holds (``out``) and who holds it
(``in``). Both come from the ``context`` relationship rows; this value is one peer
entity with its direction, enough to draw a row with no further request.
"""

from __future__ import annotations

from typing import ClassVar

from flow_sdk.schema.data_spec.spec import DataSpec


class ContextRelationSpec(DataSpec):
    spec_kind: ClassVar[str] = "context.relation"

    #: ``out`` — this entity holds the peer; ``in`` — the peer holds it; ``both``.
    direction: str
    #: The peer, as ``<type>-<id>``, and its type on its own for the icon.
    typeid: str
    type: str
    #: The peer's display name.
    name: str
    #: How it is held: ``shared`` / ``private`` / ``target`` (several, comma-joined, when both ways differ).
    kind: str = ""
    #: The entry's role (``session``, ``plan``), ``""`` when none.
    role: str = ""
    #: When the newest of the entries was made (ISO); ``""`` when unknown.
    time: str = ""
