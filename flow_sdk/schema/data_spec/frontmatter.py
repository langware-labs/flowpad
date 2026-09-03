"""``FrontMatter`` — a ``DataSpec`` for a DISK document.

Pure content. No ``id``: identity is not content, it is a CARRIER — the ``id:``
key of a markdown document's frontmatter, or ``.flow/capsules/identity.json``
beside a folder's json main document — and the identity-carrier seam
(``fs_store/indexer/functions/_asset_identity.py``) reads and writes it for
every layout. A ``FrontMatter`` class never declares the field.

The one difference from ``DataSpec``: ``extra="ignore"``. A hand-edited file
may carry keys the class does not declare; they are DROPPED on read and never
written — which is what makes "what is on disk" exactly "what the class says".
The round-trip matrix pins it. (A wire spec keeps ``forbid``.)
"""

from __future__ import annotations

from typing import Any, ClassVar

from pydantic import ConfigDict, SerializationInfo, model_serializer, model_validator

from flow_sdk.schema.data_spec.spec import DataSpec


class FrontMatter(DataSpec):
    model_config = ConfigDict(extra="ignore")


class SectionedHeader(FrontMatter):
    """A header some of whose fields live under one nested key of the document
    (``summary: {verdict, cost_usd}`` in a trace, ``data: {…}`` in a report).

    The class stays FLAT — every field is a plain entity field — and the section
    is a layout fact: reads lift ``doc[_section][k]`` up (a top-level key wins);
    a dump made FOR THE FILE (``context={"sectioned": True}`` — the disk
    serializer's render) pushes ``_section_fields`` back under ``_section``.
    Every other dump stays flat, because it feeds the row. Replaces one hand
    flattener per type.
    """

    _section: ClassVar[str | None] = None
    _section_fields: ClassVar[frozenset[str]] = frozenset()

    @model_validator(mode="before")
    @classmethod
    def _lift_section(cls, values: Any) -> Any:
        if not cls._section or not isinstance(values, dict):
            return values
        nested = values.get(cls._section)
        if not isinstance(nested, dict):
            return values
        out = {k: v for k, v in values.items() if k != cls._section}
        for k in cls._section_fields:
            if k in nested and k not in out:
                out[k] = nested[k]
        return out

    @model_serializer(mode="wrap")
    def _push_section(self, nxt: Any, info: SerializationInfo) -> Any:
        data = nxt(self)
        for_file = bool(info.context and info.context.get("sectioned"))
        if not for_file or not self._section or not isinstance(data, dict):
            return data
        inner = {k: data.pop(k) for k in list(data) if k in self._section_fields}
        if inner:
            data[self._section] = inner
        return data
