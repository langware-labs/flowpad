"""``field_persistence`` — THE one mapping from a declared field type to what
persisting it means. Every serializer walks ``cls.model_fields`` through it;
none of them names a concrete asset class. A sub-asset is recognised by the
REGISTRY (a nested class whose type has an ``asset_spec``), never by
inheritance."""

from __future__ import annotations

import types
import typing
from dataclasses import dataclass
from enum import Enum
from functools import cache
from typing import Any, Optional, Union, get_args, get_origin

from flow_sdk.schema.data_spec.markers import BodyMarker, FreeSectionMarker, marker_of


class FieldKind(str, Enum):
    SCALAR = "scalar"            # JSON-able; every serializer can hold it
    FILE_REF = "file_ref"        # a path to bytes — disk only
    FOLDER_SPEC = "folder"       # a directory of files — disk only
    SUB_ASSET = "sub_asset"      # a nested asset type (has its own TypeInfo.asset_spec) — disk only
    SUB_ASSET_LIST = "sub_asset_list"
    ROWS = "rows"                # list[ExampleSpec] — written by a DatasetLayout; disk only
    BODY = "body"                # the main document's markdown body; a plain str on every other medium
    FREE_SECTION = "free_section"  # the JSON manifest's free ``data`` section; a plain dict elsewhere


DISK_ONLY = frozenset({FieldKind.FILE_REF, FieldKind.FOLDER_SPEC, FieldKind.SUB_ASSET, FieldKind.SUB_ASSET_LIST, FieldKind.ROWS})


def unwrap_annotation(annotation: Any) -> Any:
    """Peel ``Optional`` and ``Annotated`` down to the core type, repeatedly."""
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


def type_default(cls: Any) -> str:
    """The registered type name a class carries as its ``type`` field default, or ``""``."""
    field = getattr(cls, "model_fields", {}).get("type") if isinstance(cls, type) else None
    return str(field.default) if field is not None and field.default else ""


def asset_info(cls: Any) -> Any:
    """The registered ``TypeInfo`` of a class whose ``type`` field default names
    a type WITH an ``asset_spec`` — i.e. a class that is an asset in its own
    right — else None. A registry lookup at call time: nothing here is memoized
    on inheritance, so a type registered later is seen the moment it is."""
    if not isinstance(cls, type):
        return None
    name = type_default(cls)
    if not name:
        return None
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415 — cycle-safe: lazy

    info = SchemaRegistry.get(name)
    return info if info is not None and info.asset_spec is not None else None


def asset_class(annotation: Any) -> tuple[Optional[type], bool]:
    """``(asset_cls, is_list)`` when the annotation names an asset type; else ``(None, False)``."""
    ann = unwrap_annotation(annotation)
    if get_origin(ann) is list:
        (inner,) = get_args(ann) or (None,)
        return (inner, True) if asset_info(inner) is not None else (None, False)
    return (ann, False) if asset_info(ann) is not None else (None, False)


_MARKER_KINDS = {BodyMarker: FieldKind.BODY, FreeSectionMarker: FieldKind.FREE_SECTION}


def field_persistence(annotation: Any) -> FieldKind:
    """The persistence class of one annotation (a FULL annotation — for a
    pydantic field pass ``field.rebuild_annotation()``, which re-wraps the
    ``Annotated`` extras pydantic moved into ``FieldInfo.metadata``)."""
    from flow_sdk.schema.data_spec.dataset_spec import ExampleSpec, FileRef, FolderSpec  # noqa: PLC0415

    marker = marker_of(annotation)
    if marker is not None:
        return _MARKER_KINDS[type(marker)]
    sub, is_list = asset_class(annotation)
    if sub is not None:
        return FieldKind.SUB_ASSET_LIST if is_list else FieldKind.SUB_ASSET
    ann = unwrap_annotation(annotation)
    if get_origin(ann) is list:
        (ann,) = get_args(ann) or (Any,)
        ann = unwrap_annotation(ann)
        if isinstance(ann, type) and issubclass(ann, ExampleSpec):
            return FieldKind.ROWS
    if isinstance(ann, type):
        if issubclass(ann, FolderSpec):
            return FieldKind.FOLDER_SPEC
        if issubclass(ann, FileRef):
            return FieldKind.FILE_REF
    return FieldKind.SCALAR


@cache
def field_kinds(cls: type) -> tuple[tuple[str, FieldKind], ...]:
    """``(name, kind)`` for every field of ``cls`` — a pure function of the
    class and the registry, computed once (the serializers walk it on every
    store/load). ``SchemaRegistry.register`` clears it when a new asset type
    arrives, since that can turn a field into a sub-asset."""
    return tuple((name, field_persistence(field.rebuild_annotation())) for name, field in cls.model_fields.items())


@dataclass(frozen=True)
class SpecLayout:
    """What a spec says about its MAIN document: the field that is the markdown
    body, the field that is the free JSON section — each at most one."""

    body: Optional[str]
    free: Optional[str]
    #: Every other field — what the header (frontmatter / ``metadata``) holds.
    header_fields: frozenset[str]

    @property
    def marker_fields(self) -> frozenset[str]:
        return frozenset(n for n in (self.body, self.free) if n)


@cache
def spec_layout(spec: type) -> SpecLayout:
    body = free = None
    header: list[str] = []
    for name, kind in field_kinds(spec):
        if kind is FieldKind.BODY:
            if body:
                raise TypeError(f"{spec.__name__}: at most one Body field ({body}, {name})")
            body = name
        elif kind is FieldKind.FREE_SECTION:
            if free:
                raise TypeError(f"{spec.__name__}: at most one FreeSection field ({free}, {name})")
            free = name
        else:
            header.append(name)
    return SpecLayout(body=body, free=free, header_fields=frozenset(header))
