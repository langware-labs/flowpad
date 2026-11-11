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
* ``preserved_fields_on_save`` closes the last door: a SAVE. A save writes the
  whole row, so any writer holding a copy read before the projection last moved
  (a hub frame, a disk→DB record refresh, the unread recount) wrote its stale
  ``message_ids`` back over the fresh ones — the new message stayed in the
  pointer index and the edge table, and vanished from the row the UI renders.
  The driver asks this hook under the writer transaction, against the stored
  ``data`` it is about to overwrite (``_preserve_managed_data_fields``), on
  every update path — ordinary and bulk — so every projection a save did not
  itself set is written back unchanged.

Declare ``projected_fields`` and ``projection_writer`` on the subclass; the
latter names the function that IS allowed to write, and appears in the error a
developer will read.

``derived_fields`` / ``derived_writer`` declare the SAME kind of fact one step
softer: a field computed by exactly one deriver (``Dataset`` counts, a ``Tab``'s
target) whose direct writers have not all been moved yet. A direct assignment
WARNS while ``REFUSE_DERIVED_WRITES`` is off, and raises like a projection once
it is on; inbound bodies drop them the same way; a save does NOT preserve them
(the deriver writes the whole truth each time). Every other persisted field is
authored or identity — the default, undeclared. ``derived_field_names`` is what
the policy test reads.
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import ClassVar, FrozenSet, Iterator

from flow_sdk import service_log

#: Warn mode (False): a direct write to a ``derived_fields`` member logs and
#: proceeds. Refuse mode (True): it raises, exactly like a projection.
REFUSE_DERIVED_WRITES = False

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
    #: Fields computed by ONE deriver; a direct write warns (or refuses, see
    #: ``REFUSE_DERIVED_WRITES``).
    derived_fields: ClassVar[FrozenSet[str]] = frozenset()
    #: The one function that computes ``derived_fields``.
    derived_writer: ClassVar[str] = ""

    def __setattr__(self, key, value):
        if (
            key in self.projected_fields or key in self.derived_fields
        ) and not self.__dict__.get("_allow_projection_write", False):
            if key in self.projected_fields:
                raise AttributeError(
                    f"{type(self).__name__}.{key} is a projection — write via "
                    f"{self.projection_writer}, not directly"
                )
            msg = f"{type(self).__name__}.{key} is derived — write via {self.derived_writer}, not directly"
            if REFUSE_DERIVED_WRITES:
                raise AttributeError(msg)
            service_log.warn(msg)
        return super().__setattr__(key, value)

    def _write_derived(self, **values) -> None:
        """The deriver's write: every ``derived_fields`` value it computed, guard open."""
        with self._projection_write():
            for key, value in values.items():
                setattr(self, key, value)

    def apply_field_updates(self, fields: dict):
        """Drop projection fields from inbound PUT/PATCH bodies.

        See the module docstring: a typical client save includes them, and
        refusing would break generic graph CRUD for every such save.
        """
        if fields:
            dropped = self.projected_fields | self.derived_fields
            fields = {k: v for k, v in fields.items() if k not in dropped}
        return super().apply_field_updates(fields)

    @contextmanager
    def _projection_write(self) -> Iterator[None]:
        """Hold the guard open for the duration of the block.

        ``object.__setattr__`` so the flag itself doesn't recurse through the
        guard; ``finally`` so a failed write can't leave the door open. Used by
        ``_set_projection`` and by the driver's write-back of preserved fields.
        """
        object.__setattr__(self, "_allow_projection_write", True)
        try:
            yield
        finally:
            object.__setattr__(self, "_allow_projection_write", False)

    def _set_projection(self, key: str, value, sentinel) -> None:
        """The one sanctioned writer. ``sentinel`` must be ``PROJECTION_SENTINEL``."""
        if sentinel is not _SENTINEL:
            raise PermissionError("invalid projection sentinel")
        with self._projection_write():
            setattr(self, key, value)
        written = self.__dict__.get("_projections_set")
        object.__setattr__(self, "_projections_set", (written or frozenset()) | {key})

    def preserved_fields_on_save(self, current_data: dict) -> tuple[str, ...]:
        """On a save of an existing row: every projected field this instance did
        NOT set through ``_set_projection`` keeps its stored value.

        Called by the driver inside the writer transaction, against the stored
        ``data`` the UPDATE is about to replace — no projection can land between
        the read and the write. Clears the set: the next save of this same
        instance starts from "set nothing" again.
        """
        written = self.__dict__.get("_projections_set") or frozenset()
        object.__setattr__(self, "_projections_set", frozenset())
        if not current_data:
            return ()
        return tuple(f for f in self.projected_fields if f not in written)


def derived_field_names(cls) -> FrozenSet[str]:
    """Every field ``cls`` declares derived — projected or derived, one answer."""
    return frozenset(getattr(cls, "projected_fields", ())) | frozenset(getattr(cls, "derived_fields", ()))


#: Re-exported for the sanctioned writers. One object, not one per module.
PROJECTION_SENTINEL = _SENTINEL
