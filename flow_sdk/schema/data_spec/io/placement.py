"""Where one field's value lands. THE one rule, read off the annotation.

This is the placement table for ``save``/``load``. It replaced the ``Body`` /
``FreeSection`` / ``SubAsset`` markers, which are gone.

``fs_store/serializer/fields.py``'s ``FieldKind`` is also live, and an earlier
version of this docstring said it "answers the same question". **It does not.**
Measured over every registered spec, every entity and every nested ``DataSpec``
(``test_the_two_classification_tables.py``): neither enum determines the other.
``SCALAR`` maps to three placements and ``DIR_LIST`` to two kinds, because the
two ask different things — ``FieldKind`` asks *can a serializer hold this as
JSON?* (a list of value shapes can, so it is ``SCALAR``), this table asks
*where does it land?* (a list of shapes is a DIRECTORY).

The 33 fields they place differently are therefore not drift to be reconciled;
they are the substance of why this module is NOT the asset writer — it would
explode an inline list or dict into a directory tree. The relationship between
the two is pinned by that test, so a new pair fails the build rather than
passing unnoticed.

What this table does replace is the ``Body`` / ``FreeSection`` / ``SubAsset``
markers. The difference is where the answer comes from: a marker let a field SAY
where it goes; a type IS what it is, and the placement follows.

Two distinctions carry the whole table:

* **a value vs a document.** ``AssetDocumentSpec`` already means "I am a disk
  document" (``frontmatter.py:24``) — that is why ``markdown`` needed no new
  primitive: ``MarkdownSpec`` was already the carrier. A plain ``DataSpec`` is a
  value and rides inside its parent's json.
* **one vs many.** A list or a dict of shapes is a DIRECTORY, because each
  element wants to be opened, diffed and edited on its own. A single shape does
  not — promoting it would bury a two-field value in a folder of its own.

Stdlib + pydantic only, like the rest of ``data_spec``.
"""

from __future__ import annotations

import types
import typing
from functools import lru_cache
from types import MappingProxyType
from typing import Any, Mapping, Optional, Union, get_args, get_origin

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.frontmatter import AssetDocumentSpec
from flow_sdk.schema.data_spec.spec import DataSpec


class Placement(StrEnum):
    """Where a field's value is written, relative to its parent's document."""

    #: In the parent's json. Scalars, and a nested VALUE shape.
    INLINE = "inline"
    #: Its own document beside the parent — ``<field>.<ext>``.
    DOCUMENT = "document"
    #: Its own file of bytes — ``<field>.<ext>``.
    FILE_BYTES = "file_bytes"
    #: A directory named by the field, one folder per element.
    DIR_LIST = "dir_list"
    #: A directory named by the field, one folder per KEY.
    DIR_DICT = "dir_dict"
    #: The untyped ``data`` half of a two-section document. Stored inline like
    #: any other value here; it is a placement of its own because the format
    #: distinguishes it — one of the three cases where this table and
    #: ``fields.FieldKind`` do coincide.
    FREE_SECTION = "free_section"
    #: THIS document's own content, under its frontmatter. The terminal of the
    #: document recursion — a ``Text`` field is what a document IS, not a field
    #: it has, which is why it is not ``INLINE``.
    BODY = "body"


def unwrap(annotation: Any) -> Any:
    """Peel ``Optional`` and ``Annotated`` down to the core type, repeatedly.

    ``Optional`` is deliberately transparent here: whether a value may be absent
    is behaviour, not shape, and an absent value simply writes nothing. Ported
    from ``fs_store/serializer/fields.py:33`` — the one piece of that module
    worth keeping.
    """
    while True:
        origin = get_origin(annotation)
        if origin in (Union, types.UnionType):
            args = [a for a in get_args(annotation) if a is not type(None)]
            if len(args) != 1:
                return annotation
            annotation = args[0]
        elif origin is typing.Annotated:
            annotation = get_args(annotation)[0]
        else:
            return annotation


def is_document(shape: Any) -> bool:
    """Is this shape a DISK DOCUMENT rather than a value?

    Two ways to be one, and both are read off the type:

    * it declares a ``Text`` field — it HAS content, so it is a file
    * it subclasses ``AssetDocumentSpec``, which already means exactly this
      (``frontmatter.py:24``) even for a document that is pure frontmatter

    The whole file/inline decision, in one predicate — a question about the
    type, never about the field that holds it.

    This used to ask ``placement_of`` for each field and look for
    ``Placement.BODY``, which made it mutually recursive with ``placement_of``
    and needed a cycle guard plus a memo with a subtle "only cache a result
    reached from the top" rule. **The recursion could never change the answer:**
    ``placement_of`` returns ``BODY`` only for a ``Text`` core, and it decides
    that before it ever calls back here — so every recursive answer was computed
    and discarded. Asking the question directly is equivalent (verified over all
    159 ``DataSpec`` subclasses), and a shape reachable from itself is no longer
    a special case because nothing recurses.
    """
    if not is_shape(shape):
        return False
    if issubclass(shape, AssetDocumentSpec):
        return True
    from flow_sdk.schema.data_spec.io.native import Text  # noqa: PLC0415 — cycle-safe

    return any(
        isinstance(core, type) and issubclass(core, Text)
        for core in (unwrap(f.rebuild_annotation()) for f in shape.model_fields.values())
    )


def is_shape(shape: Any) -> bool:
    return isinstance(shape, type) and issubclass(shape, DataSpec)


def element_of(annotation: Any) -> Any:
    """The element type of a ``list[...]``, or ``None`` when it is not one."""
    core = unwrap(annotation)
    if get_origin(core) is list:
        args = get_args(core)
        return unwrap(args[0]) if args else None
    return None


def value_of(annotation: Any) -> Any:
    """The value type of a ``dict[str, ...]``, or ``None``."""
    core = unwrap(annotation)
    if get_origin(core) is dict:
        args = get_args(core)
        return unwrap(args[1]) if len(args) == 2 else None
    return None


def placement_of(annotation: Any) -> Placement:
    """Where a field with this annotation is written.

    A ``dict``/``list`` of anything that is NOT a shape stays inline — a
    ``dict[str, str]`` is a value, and a folder of one-line files would be a
    worse way to hold it, not a better one.
    """
    core = unwrap(annotation)

    from flow_sdk.schema.data_spec.io.native import Binary, FreeForm, Text  # noqa: PLC0415 — cycle-safe

    if isinstance(core, type) and issubclass(core, Text):
        return Placement.BODY
    if isinstance(core, type) and issubclass(core, FreeForm):
        return Placement.FREE_SECTION
    if isinstance(core, type) and issubclass(core, Binary):
        return Placement.FILE_BYTES
    if is_shape(core):
        return Placement.DOCUMENT if is_document(core) else Placement.INLINE
    element = element_of(core)
    if element is not None and is_shape(element):
        return Placement.DIR_LIST

    valued = value_of(core)
    if valued is not None and is_shape(valued):
        return Placement.DIR_DICT

    return Placement.INLINE


@lru_cache(maxsize=None)
def placements(spec: type) -> "Mapping[str, Placement]":
    """Every field of *spec*, by placement. The reader and the writer share it,
    which is what makes a round trip symmetric by construction rather than by
    two functions agreeing.

    Read-only: the result is CACHED, so handing back a plain dict would let one
    caller's edit reach every later caller. No caller mutates it today, which is
    exactly why the day one does would be hard to find.
    """
    out: dict[str, Placement] = {}
    for name, field in spec.model_fields.items():
        # ``rebuild_annotation`` re-wraps what pydantic moved into
        # ``FieldInfo.metadata``; ``.annotation`` alone silently drops it.
        out[name] = placement_of(field.rebuild_annotation())
    return MappingProxyType(out)


__all__ = [
    "Placement",
    "body_field",
    "element_of",
    "is_document",
    "is_shape",
    "placement_of",
    "placements",
    "unwrap",
    "value_of",
]


def body_field(spec: type) -> "Optional[str]":
    """The one field that is this document's content, or ``None``.

    At most one: two bodies would make the file ambiguous, and the old code
    raised for exactly that reason (``"at most one Body field"``). The check
    stays; only where the answer comes from has changed.
    """
    found = [n for n, p in placements(spec).items() if p is Placement.BODY]
    if len(found) > 1:
        raise TypeError(f"{spec.__name__}: at most one Text field ({', '.join(found)})")
    return found[0] if found else None
