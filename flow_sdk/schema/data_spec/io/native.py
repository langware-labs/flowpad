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

import base64
import binascii
from pathlib import Path
from typing import Any, Optional

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
    """A string that is a document's content, not one of its fields.

    ``path`` is the file it lives in: set by ``load`` (the file it was read from) and by ``save`` (the file
    it was written to) — one ``names.field_file`` rule, so ``value.body.path`` is where ``save`` puts it.
    ``None`` for a value that has never touched disk.
    """

    path: Optional[Path] = None

    __get_pydantic_core_schema__ = _carrier_schema(core_schema.str_schema)


class Binary(bytes):
    """Bytes that are a file, not a field. Written as ``<field><ext>``; ``path`` as on ``Text``.

    A ``Binary`` carries its ``media_type``; the file's extension is derived from it (``names.ext_for_media``),
    so a decoded screenshot is ``screenshot.png``. Over JSON (a browser, a REST write) bytes travel as a
    ``data:<media type>;base64,…`` URL — decoded on the way in, and what a JSON read hands back, so a value
    round-trips through a page unchanged. Bytes given as bytes are ``application/octet-stream`` (``.bin``);
    a plain string is its UTF-8 bytes, as before.
    """

    path: Optional[Path] = None

    #: What the bytes are; names the file and the data URL.
    media_type: str

    def __new__(cls, data: Any = b"", media_type: str = "application/octet-stream") -> "Binary":
        out = super().__new__(cls, data)
        out.media_type = media_type
        return out

    def __reduce__(self) -> tuple:
        # copy / deepcopy / pickle keep what the bytes are (a plain ``bytes`` rebuild would drop it).
        return (type(self), (bytes(self), self.media_type))

    @classmethod
    def of(cls, data: bytes, media_type: str) -> "Binary":
        return cls(data, media_type)

    @classmethod
    def from_file(cls, path: Path) -> "Binary":
        from flow_sdk.schema.data_spec.io import names  # noqa: PLC0415 — cycle-safe: lazy

        out = cls.of(path.read_bytes(), names.media_for_ext(path.suffix))
        out.path = path
        return out

    @property
    def ext(self) -> str:
        from flow_sdk.schema.data_spec.io import names  # noqa: PLC0415

        return names.ext_for_media(self.media_type)

    def to_data_url(self) -> str:
        return f"data:{self.media_type};base64,{base64.b64encode(self).decode('ascii')}"

    @classmethod
    def __get_pydantic_core_schema__(cls, source: Any, handler: Any) -> Any:
        def validate(value: Any, inner: Any) -> "Binary":
            if isinstance(value, cls):
                return value
            if isinstance(value, str) and value.startswith("data:"):
                head, sep, payload = value.partition(",")
                if not (sep and head.endswith(";base64")):
                    raise ValueError("a data URL for binary must be base64: data:<media type>;base64,<data>")
                try:
                    data = base64.b64decode(payload, validate=True)
                except (binascii.Error, ValueError) as exc:
                    raise ValueError(f"the data URL's base64 does not decode: {exc}") from exc
                return cls.of(data, head[5:-7].strip().lower() or "application/octet-stream")
            return cls(inner(value))

        return core_schema.no_info_wrap_validator_function(
            validate,
            core_schema.bytes_schema(),
            # The validator always yields a ``Binary``; plain bytes only reach here unvalidated.
            serialization=core_schema.plain_serializer_function_ser_schema(
                lambda value: (value if isinstance(value, Binary) else cls(value)).to_data_url(), when_used="json",
            ),
        )


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
