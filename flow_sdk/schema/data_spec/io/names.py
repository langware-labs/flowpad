"""What each thing on disk is CALLED. One answer per question, derived.

Three questions, and the old code answered them in three different places
(``TypeInfo``/``Layout`` for the main document, the field name for a body, the
nested type's placement for an extension). They are all here now, and they are
all derived:

* the main document  -> ``<kind>.json``, the kind being the type's OWN name
* a field's file     -> ``<field><ext>`` — the field name IS the file name
* a list element     -> its ``name``, else its ordinal
* a dict element     -> its key

**The kind, not ``spec_kind``.** 16 of 20 asset specs declare no ``spec_kind``
and derive their kind from the registered type name (``docs/ontology.md`` rule
4, implemented at ``schema_registry.py:1102``). Reading ``cls.spec_kind`` would
name most documents after nothing, and an INHERITED ClassVar would name a
subclass's file after its parent — which is why the lookup is identity-keyed
(``kind_for``), never attribute access.

**The bare kind.** A namespaced kind is ``--acme--.ingest.message.whatsapp``;
``--acme--`` is not a filename anyone wants and ``--flow--`` is never written
at all. The file is named from the last plain segment.

Stdlib only. The one registry call is lazy, the guard ``_kinds.py`` established.
"""

from __future__ import annotations

import re
from typing import Any

#: An ordinal folder for a list element that carries no name. Four digits sorts
#: lexicographically in insertion order up to 10k, and it is the numbering the
#: dataset layout already used for example folders — so existing trees keep
#: their names.
ORDINAL = "{:04d}"

#: A single path component, and nothing clever: no separator, no traversal, no
#: leading dot. A dict key becomes a folder name, and a key is user data.
_SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")


class UnsafeName(ValueError):
    """A key or name that cannot be a folder. Raised at the WRITE, where the
    value is still in hand and the author can be told which key."""


def kind_of(spec: type) -> str:
    """The registered kind of *spec* — its type name, or its declared alias.

    Falls back to the class name for an anonymous shape, which is the only case
    where nothing has named it.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415 — cycle-safe: lazy

    kind = SchemaRegistry.kind_for(spec)
    if kind:
        return kind
    # A pydantic parametrization inherits its origin's kind and deliberately
    # does NOT register (docs/ontology.md, "Composition"). Its __name__ is
    # ``ExampleSpec[Question, Answer, DataSpec]`` — brackets, commas and spaces,
    # none of which belong in a filename. Ask the origin instead.
    origin = (getattr(spec, "__pydantic_generic_metadata__", {}) or {}).get("origin")
    if origin is not None and origin is not spec:
        return kind_of(origin)
    return getattr(spec, "spec_kind", "") or spec.__name__.lower()


def bare(kind: str) -> str:
    """The filename-safe tail of a kind. ``--acme--.ingest.message`` -> ``message``."""
    return kind.rsplit(".", 1)[-1] if kind else kind


def main_document(spec: type) -> str:
    """The name of the json that holds *spec*'s own fields."""
    return f"{bare(kind_of(spec))}.json"


def field_file(field: str, ext: str) -> str:
    """A field kept beside the main document. The FIELD NAME is the file name —
    ``setup`` is ``setup.md``, and nothing else needs to be declared."""
    return f"{field}{ext if ext.startswith('.') else '.' + ext}"


def safe_component(value: str, *, what: str) -> str:
    """*value* as one path component, or raise saying which one was wrong."""
    text = (value or "").strip()
    if not _SAFE_COMPONENT.match(text):
        raise UnsafeName(
            f"{what} {value!r} cannot be a folder name — one plain component, "
            "letters/digits/._- only, no separators"
        )
    return text


def list_element(element: Any, index: int) -> str:
    """The folder for one element of a list.

    Its own ``name`` when it has one — a named thing should be findable by its
    name, not by where it happened to sit. An ordinal otherwise, which is what
    lets a list of UNNAMED shapes be written at all; the old code raised
    (``"*.name is required to place it in a directory"``) and so a perfectly
    ordinary list was simply unsupported.
    """
    name = getattr(element, "name", None)
    if isinstance(name, str) and name.strip():
        return safe_component(name, what="element name")
    return ORDINAL.format(index)


def dict_element(key: str) -> str:
    """The folder for one entry of a dict. The key names it."""
    return safe_component(key, what="dict key")


def ext_for(spec: type, default: str = ".md") -> str:
    """The extension a document shape is written with.

    ``TypeInfo.shape`` knows this for a registered asset type; the default is
    markdown because every document carrier in the tree today is one.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415 — cycle-safe: lazy

    info = SchemaRegistry.get(kind_of(spec))
    shape = getattr(info, "shape", None) if info is not None else None
    return getattr(shape, "ext", None) or default


__all__ = [
    "ORDINAL",
    "UnsafeName",
    "bare",
    "dict_element",
    "ext_for",
    "field_file",
    "kind_of",
    "list_element",
    "main_document",
    "safe_component",
]
