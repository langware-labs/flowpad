"""ProjectedFields — the guard for entity fields that are derived, not written.

Some entity fields are a PROJECTION of a source of truth that lives elsewhere:
``Conversation.message_ids``/``message_count`` project ``conversation.jsonl``;
``MessageThread.message_count`` projects the messages carrying its id. A direct
assignment to one of those is always a bug — it desynchronises the row from the
thing it summarises, silently and durably.

Three pieces, and all three are needed:

* ``__setattr__`` refuses the write, so the bug surfaces at its cause.
* ``apply_field_updates`` SILENTLY DROPS them instead — a client save
  round-trips the whole entity dump, so re-applying identical values would be a
  no-op that the guard would nonetheless 500 on. Without this the guard is
  leaky in the other direction: generic graph CRUD breaks.
* ``_set_projection`` is the one sanctioned writer, gated on a module-private
  sentinel so a call site has to reach for it deliberately.
* ``_adopt_stored_projections`` closes the last door: a SAVE. A save writes the
  whole row, so any writer holding a copy read before the projection last moved
  (a hub frame, a disk→DB record refresh, the unread recount) wrote its stale
  ``message_ids`` back over the fresh ones — the new message stayed in the
  pointer index and the edge table, and vanished from the row the UI renders.
  ``Entity.save`` calls it inside the record guard and the writer transaction,
  so every projection a save did not itself set is re-read from the stored row
  and written back unchanged.

Declare ``projected_fields`` and ``projection_writer`` on the subclass; the
latter names the function that IS allowed to write, and appears in the error a
developer will read.
"""
from __future__ import annotations

from typing import ClassVar, FrozenSet

#: Held privately here so a caller cannot pass it accidentally. The sentinel is
#: not the security boundary — it is a speed bump that makes the sanctioned
#: writer the obvious path.
_SENTINEL = object()


class ProjectedFields:
    """Mixin for entities carrying derived fields. Subclasses declare both."""

    #: Field names that may not be assigned directly.
    projected_fields: ClassVar[FrozenSet[str]] = frozenset()
    #: What a developer should call instead, named in the refusal message.
    projection_writer: ClassVar[str] = "the projection writer"

    def __setattr__(self, key, value):
        if (
            key in self.projected_fields
            and not self.__dict__.get("_allow_projection_write", False)
        ):
            raise AttributeError(
                f"{type(self).__name__}.{key} is a projection — write via "
                f"{self.projection_writer}, not directly"
            )
        return super().__setattr__(key, value)

    def apply_field_updates(self, fields: dict):
        """Drop projection fields from inbound PUT/PATCH bodies.

        See the module docstring: a typical client save includes them, and
        refusing would break generic graph CRUD for every such save.
        """
        if fields:
            fields = {k: v for k, v in fields.items() if k not in self.projected_fields}
        return super().apply_field_updates(fields)

    def _set_projection(self, key: str, value, sentinel) -> None:
        """The one sanctioned writer. ``sentinel`` must be ``PROJECTION_SENTINEL``."""
        if sentinel is not _SENTINEL:
            raise PermissionError("invalid projection sentinel")
        # object.__setattr__ so the flag itself doesn't recurse through the
        # guard; try/finally so a failed write can't leave the door open.
        object.__setattr__(self, "_allow_projection_write", True)
        try:
            setattr(self, key, value)
        finally:
            object.__setattr__(self, "_allow_projection_write", False)
        written = self.__dict__.get("_projections_set")
        object.__setattr__(self, "_projections_set", (written or frozenset()) | {key})

    async def _adopt_stored_projections(self) -> None:
        """Before a save of an existing row: take every projected field this
        instance did NOT set through ``_set_projection`` from the stored row.

        The caller holds the record guard and the writer transaction, so the
        read and the write that follows are one step — no projection can land
        between them. Clears the set afterwards: the next save of this same
        instance starts from "set nothing" again.
        """
        written = self.__dict__.get("_projections_set") or frozenset()
        object.__setattr__(self, "_projections_set", frozenset())
        stale = [f for f in self.projected_fields if f not in written]
        if not stale:
            return
        stored = await self._db.get_by_id(str(self.id), self.get_type())
        if stored is None:
            return
        object.__setattr__(self, "_allow_projection_write", True)
        try:
            for field in stale:
                setattr(self, field, getattr(stored, field, None))
        finally:
            object.__setattr__(self, "_allow_projection_write", False)


#: Re-exported for the sanctioned writers. One object, not one per module.
PROJECTION_SENTINEL = _SENTINEL
