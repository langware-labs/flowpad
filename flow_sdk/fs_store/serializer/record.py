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


def fts_content(obj: Any, info: Any) -> str:
    """The FTS ``content`` column for ``obj``: ``TypeInfo.fts_content`` fields
    joined by newlines (a list-valued field joins by spaces)."""
    parts = []
    for name in info.fts_content or ():
        value = getattr(obj, name, None)
        if isinstance(value, (list, tuple)):
            value = " ".join(str(v) for v in value if v)
        if value:
            parts.append(str(value))
    return "\n".join(parts).strip()



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
            from flow_sdk.assets.serialization import read_asset_data, read_main

            obj = read_asset_data(root, info, identity=resolved_id)
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
            _, header = read_main(info, root)
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
