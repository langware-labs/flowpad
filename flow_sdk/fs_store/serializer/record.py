"""``spec_extractor`` — the one ``from_disk_fn`` for every type with an ``asset_spec``.

An extractor does five things and every spec-bearing type needs the same five:
find the asset ROOT the walker's ref points at, decode its filesystem data, emit
the authored fields plus the FTS composite, anchor the
record's ``asset_ref``, and carry the walk scope. Per-type facts live in
``TypeInfo`` (layout, ``fts_content``) and in ``derive_fields_fn``.
"""

from __future__ import annotations

import logging
from typing import Any

from flow_sdk.assets.layout import Folder

logger = logging.getLogger(__name__)


# ``TypeInfo.fts`` buckets — the bm25 weight of the FTS column a source feeds
# (production ranks with ``bm25(entities_fts, 0, 0, 10, 8, 3, 1)``).
FTS_WEIGHT_NAME = 10
FTS_WEIGHT_TITLE = 8
FTS_WEIGHT_DESCRIPTION = 3
FTS_WEIGHT_CONTENT = 1


def _text_of(obj: Any, sources: Any) -> str:
    from flow_sdk.datasets.query import field_of  # noqa: PLC0415 -- lazy: the scan child must not load it

    parts = []
    for source in sources:
        value = field_of(obj, source)   # a dotted path through attributes and keys; accessors are properties
        if isinstance(value, (list, tuple)):
            value = " ".join(str(v) for v in value if v)
        if value:
            parts.append(str(value))
    return "\n".join(parts).strip()


#: Where a type that declares no ``TypeInfo.fts`` source for a column takes it from.
_FTS_DEFAULT = {FTS_WEIGHT_NAME: "name", FTS_WEIGHT_TITLE: "title", FTS_WEIGHT_DESCRIPTION: "description"}


def fts_text(obj: Any, info: Any, weight: int) -> str:
    """The text for the column of bm25 ``weight``: the ``TypeInfo.fts`` sources routed there, else the
    column's default field ("" when neither has text)."""
    declared = getattr(info, "fts", None) or {}
    routed = _text_of(obj, [source for source, bucket in declared.items() if bucket == weight])
    return routed or (_text_of(obj, [_FTS_DEFAULT[weight]]) if weight in _FTS_DEFAULT else "")


def fts_content(obj: Any, info: Any) -> str:
    """The FTS ``content`` column for ``obj``: ``TypeInfo.fts_content`` sources
    (then any ``TypeInfo.fts`` source in the content bucket) joined by newlines
    (a list-valued field joins by spaces). Sources may be dotted paths or accessors."""
    sources = list(info.fts_content or ())
    declared = getattr(info, "fts", None) or {}
    sources += [s for s, bucket in declared.items() if bucket == FTS_WEIGHT_CONTENT and s not in sources]
    return _text_of(obj, sources)



def spec_extractor(type_name: str):
    """The ``from_disk_fn`` for ``type_name``; the registry lookup and the
    cycle-guarded imports resolve on the first record, not on every one."""
    from pydantic import ValidationError  # noqa: PLC0415

    from flow_sdk.capsules.errors import CapsuleError  # noqa: PLC0415
    from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
    from flow_sdk.fs_store.fs_ref import FrontMatterFsRef, FSRef  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    def extract(ref: FSRef, resolved_id: str) -> list:
        info = SchemaRegistry.get(type_name)   # a dict hit; the info may be enriched after registration
        root = info.layout_of(ref._path, verify=True).root
        if root is None:
            return []
        try:
            from flow_sdk.assets.serialization import read_asset_data_with_header

            obj, header = read_asset_data_with_header(root, info, identity=resolved_id)
        except (OSError, UnicodeDecodeError, ValueError, ValidationError, CapsuleError) as exc:
            # Binary under a .md, a rejected manifest, an unreadable file: not
            # this type's record, never the indexer's error counter.
            logger.warning("[%s] %s rejected: %s", type_name, root, exc)
            return []
        # Only filesystem fields ride the record. Entity defaults and DB-owned
        # facts are composed by from_record after this adapter returns.
        fields = obj.meta_dict()
        from flow_sdk.fs_store.serializer.fields import spec_layout

        body_field = spec_layout(info.asset_spec).body
        if body_field and fields.get(body_field) == "":
            fields.pop(body_field)  # Empty file bodies do not request a blob-store write.
        fields.pop("id", None)
        fields.pop("type", None)
        fields.pop("asset_ref", None)
        if info.row_derive_fn is not None:
            # The header the record was just decoded from — not a second read of the file.
            info.row_derive_fn(fields, root, header)
        fields["status"] = fields.get("status") or "active"
        fields["content"] = fts_content(obj, info)
        rec = FSRecord(type=type_name, id=resolved_id, **fields)
        if isinstance(info.shape, Folder):
            rec.asset_ref = FSRef(root.resolve())
        else:
            rec.asset_ref = FrontMatterFsRef(root) if info.shape.ext == ".md" else FSRef(root)
        if ref.scope:
            rec.scope = ref.scope
        return [rec]

    extract.__name__ = f"extract_{type_name}"
    return extract
