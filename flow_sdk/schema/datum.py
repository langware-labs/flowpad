"""``Datum`` — the one descriptor for data whose shape arrives AS DATA.

A datum is one node of a tree. Branches carry ``fields``; leaves carry
``value``; ``kind`` annotates either. The same shape serves as a **contract**
(no values anywhere) and as the **datum** itself (values at the leaves) — which
is why it is not called a schema or a spec.

    contract   {"fields": {"category": {"kind": "string"}}}
    datum      {"fields": {"category": {"value": "invoice"}}}

The two join by POSITION in the tree, not by matching kinds, so comparing a
produced value against an expected one is a structural walk.

**Scope.** This is for shapes that are authored or discovered at runtime — an
asset manifest, a dataset row, an I/O contract someone wrote in JSON. Shapes
declared in *source* stay Python annotations: Pydantic already types them, with
validation, serialization and static checking that a runtime tree cannot match.

**Not an entity.** No ``id``, no ``digest``. A datum is a value object; identity
and freezing belong to whatever stores an instance.

``kind`` is an ordinary dot-path tag validated by the one grammar
(``flow_sdk/tags/grammar.py``) — the same namespace bus tags and ``kind`` fields
already share. It is optional at every node: a leaf's field name usually labels
it well enough, and an un-annotated node is a legitimate state (routable and
composable, just not validatable).
"""

from __future__ import annotations

from typing import Any, Dict, Iterator, Optional

from pydantic import BaseModel, field_validator, model_validator

from flow_sdk.tags.grammar import normalize_tag


class Datum(BaseModel):
    """One node of a data tree: a branch (``fields``) or a leaf (``value``)."""

    #: Optional dot-path tag. Normalized on adopt; ``None`` means unannotated.
    kind: Optional[str] = None
    #: Branch. Child name → child node.
    fields: Optional[Dict[str, "Datum"]] = None
    #: Leaf. ``Any`` on purpose — a scalar, a list, a path, a TypeId string.
    #: ``kind`` is what says how to read a value that is a pointer.
    value: Any = None

    @field_validator("kind")
    @classmethod
    def _normalize_kind(cls, value: Optional[str]) -> Optional[str]:
        """Adopt through the one tag grammar, so a malformed kind fails at the
        WRITE. Reads (``kind_matches``) are strict, so a raw kind stored here
        would raise later at a point that cannot explain itself."""
        return None if value is None else normalize_tag(value)

    @model_validator(mode="after")
    def _branch_xor_leaf(self) -> "Datum":
        """A node is a branch or a leaf, never both.

        Without this the tree stops being a tree: a node carrying both an
        expansion and a value has two competing readings, and every consumer
        has to pick one. Raw bytes beside a parsed form is the tempting case —
        express it as two sibling leaves instead.
        """
        if self.fields is not None and self.value is not None:
            raise ValueError("a Datum is a branch (fields) or a leaf (value), never both")
        return self

    @property
    def is_leaf(self) -> bool:
        return self.fields is None

    def leaves(self, _prefix: tuple[str, ...] = ()) -> "Iterator[tuple[tuple[str, ...], Datum]]":
        """Every leaf under this node as ``(path, node)``, depth-first.

        The path IS the join key between a contract and its datum, and between a
        produced value and its expected one.
        """
        if self.fields is None:
            yield (_prefix, self)
            return
        for name, node in self.fields.items():
            yield from node.leaves((*_prefix, name))


Datum.model_rebuild()
