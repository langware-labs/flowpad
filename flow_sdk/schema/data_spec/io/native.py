"""``Text`` and ``Binary`` — the two carriers the grammar did not have.

A shape's fields are values; a document's content is not. ``Text`` is the
TERMINAL of the document recursion: ``ComputeOpSpec.setup`` is a ``MarkdownSpec``
(a document, so ``setup.md``), and ``MarkdownSpec.body`` is a ``Text`` (the raw
bytes of that file, under its frontmatter). Without a terminal the recursion has
no bottom and a document can only contain more documents.

These replace the ``Body`` marker, and the difference is the whole point of the
refactor: ``Body`` was an annotation a field CARRIED, so the storage fact lived
in ``TypeInfo`` — two places for one decision. ``Text`` is what the field IS.

**The authoring form still says ``"string"`` for a ``Text``**, exactly as ``Body``
did, because the form describes the VALUE and a ``Text`` value is a string.
Where it is stored is a different axis, and the type carries that. ``binary`` is
a form of its own because bytes are not a string in any form.

The kind ``text`` is deliberately NOT claimed: it is already bound to
``TextSpec`` (a CSV cell), which lives until ``layout.py`` is retired. Claiming
it would make ``parse("text")`` answer two different things depending on import
order, and ``register_kind`` refuses a reserved primitive outright.

A ``Text`` IS a ``str`` and a ``Binary`` IS ``bytes``: every method works, they
compare equal to their plain counterparts, and a plain value assigns cleanly.
Only ``save`` treats them differently.
"""

from __future__ import annotations

from typing import Any

from pydantic_core import core_schema


def _carrier_schema(inner: Any) -> Any:
    """A carrier validates exactly as its builtin, then wears the subclass.

    One helper rather than the same two lines on each type — the next carrier
    should not have to remember the incantation.
    """
    def build(cls: type, source: Any, handler: Any) -> Any:
        return core_schema.no_info_after_validator_function(cls, inner())

    return classmethod(build)


class Text(str):
    """A string that is a document's content, not one of its fields."""

    __get_pydantic_core_schema__ = _carrier_schema(core_schema.str_schema)


class Binary(bytes):
    """Bytes that are a file, not a field. Written as ``<field><ext>``."""

    #: What a bare ``Binary`` is written as when nothing says otherwise.
    ext: str = ".bin"

    __get_pydantic_core_schema__ = _carrier_schema(core_schema.bytes_schema)


class FreeForm(dict):
    """The untyped half of a two-section document — ``{"metadata": …, "data": …}``.

    A report's payload is data we do not model: a trace, a usage roll-up, a
    cleanup listing. It is a ``dict`` everywhere it is used, and only the
    document layout treats it specially.

    Replaces the ``FreeSection`` marker for the same reason ``Text`` replaced
    ``Body``: the marker named the field while ``TypeInfo.manifest_layout``
    named the format, so one decision lived in two places — and the implied
    default was live for exactly ONE of the four fields that carried it.
    """

    __get_pydantic_core_schema__ = _carrier_schema(
        lambda: core_schema.dict_schema(core_schema.str_schema(), core_schema.any_schema())
    )


def register() -> None:
    """Teach the authoring form about these carriers.

    ``PRIMITIVES`` (name -> type) and ``PRIMITIVE_NAMES`` (type -> name) are
    separate directions, and ``Text`` uses only the second: a ``Text`` RENDERS
    as ``"string"``, but ``"string"`` still parses back to plain ``str``. That
    asymmetry is deliberate — it keeps a ``Text``-bearing spec expressible (as
    ``Body`` was) without claiming the ``text`` kind that ``TextSpec`` holds.

    ``Binary`` takes both directions: ``binary`` is free and bytes need a form
    of their own.
    """
    from flow_sdk.schema.data_spec import _kinds  # noqa: PLC0415 — cycle-safe: lazy

    _kinds.PRIMITIVE_NAMES.setdefault(Text, "string")
    _kinds.PRIMITIVES.setdefault("binary", Binary)
    _kinds.PRIMITIVE_NAMES.setdefault(Binary, "binary")


__all__ = ["Binary", "FreeForm", "Text", "register"]
