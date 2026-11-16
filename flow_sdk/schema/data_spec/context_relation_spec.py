"""``ContextRelationSpec`` — one row of an entity's context, as the Context menu lists it.

An entity's context has two directions: what it holds (``out``) and who holds it
(``in``). Both come from the ``context`` relationship rows; this value is one peer
entity with its direction, enough to draw a row with no further request.
"""

from __future__ import annotations

from typing import ClassVar, Literal

from flow_sdk.schema.data_spec.spec import DataSpec

#: How a context entry came to be. ``static``: part of the entity's structure (a document's
#: project, a process's target). ``dynamic``: linked by the system from what happened (a plan
#: found in a session). ``user``: made by a person's action (sharing, starting a chat on it).
ContextVia = Literal["static", "dynamic", "user"]

#: Where an entry records it in its per-entry context data. Not ``via``: a package folder's entry
#: already uses that key for how its dependency is reached.
CONTEXT_VIA_KEY = "context_via"


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
    #: How the entries came to be (``ContextVia``) — several when the peer is held more than one way.
    via: list[ContextVia] = []
    #: When the newest of the entries was made (ISO); ``""`` when unknown.
    time: str = ""
