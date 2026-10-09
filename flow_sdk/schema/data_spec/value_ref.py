"""``<kind>.id.<uuid>`` -- naming ONE stored value of a schema, where a kind names them all.

An instance kind is a dot-descendant of its kind (``navigation.map.id.7c1e…`` is within
``navigation.map``), so everything that works by kind -- viewers, editors, ``kind_matches`` --
already treats a reference as its kind. ``id`` is a reserved segment: a kind never has one, and
what follows it is an entity id (``is_valid_entity_id``: v4, or v5 for a read-only asset).

Pure grammar and a field type; storing and resolving values is ``flow_sdk.values``.
"""

from __future__ import annotations

from typing import Annotated, Any, Optional

from pydantic import AfterValidator

from flow_sdk.api.api_types.identifier import is_valid_entity_id

#: The segment that turns a kind into one value of it.
ID_SEGMENT = "id"


def parse_ref(ref: Any) -> Optional[tuple[str, str]]:
    """``(kind, id)`` when ``ref`` is ``<kind>.id.<uuid>``, else None. The kind holds no ``id``
    segment of its own, and the id must be a valid entity id."""
    if not isinstance(ref, str):
        return None
    kind, sep, entity_id = ref.rpartition(f".{ID_SEGMENT}.")
    if not sep or not kind or not is_valid_entity_id(entity_id):
        return None
    if ID_SEGMENT in kind.split("."):
        return None
    return kind, entity_id


def kind_of(kind_or_ref: str) -> str:
    """The kind a name stands for: an instance kind's kind, or the name itself."""
    parsed = parse_ref(kind_or_ref)
    return parsed[0] if parsed else kind_or_ref


def ref_of(kind: str, entity_id: str) -> str:
    return f"{kind}.{ID_SEGMENT}.{entity_id}"


def value_ref(kind: str) -> Any:
    """A field type: a reference to one stored value of ``kind`` (or of a kind within it).
    ``a.kind|b.kind`` accepts a reference to a value of any of them."""
    from flow_sdk.worldview.ontology import kind_matches  # noqa: PLC0415 -- keep the grammar import-light

    kinds = kind.split("|")

    def check(ref: str) -> str:
        parsed = parse_ref(ref)
        if parsed is None:
            raise ValueError(f"{ref!r} is not a reference: expected '{kinds[0]}.{ID_SEGMENT}.<uuid>'")
        if not any(kind_matches(k, parsed[0]) for k in kinds):
            raise ValueError(f"{ref!r} refers to a {parsed[0]} value, not a {' or '.join(kinds)}")
        return ref

    return Annotated[str, AfterValidator(check)]


__all__ = ["ID_SEGMENT", "kind_of", "parse_ref", "ref_of", "value_ref"]
