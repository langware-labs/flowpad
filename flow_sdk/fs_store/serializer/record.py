"""``spec_extractor`` — the one ``from_disk_fn`` for every type with an ``asset_spec``.

An extractor does five things and every spec-bearing type needs the same five:
find the asset ROOT the walker's ref points at, ``serializer().load`` it, emit
the persisted subset (``metadata_payload``) plus the FTS composite, anchor the
record's ``asset_ref``, and carry the walk scope. Per-type facts live in
``TypeInfo`` (layout, ``fts_content``) and in ``derive_fields_fn``.
"""

from __future__ import annotations

import logging
from typing import Any

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
    from flow_sdk.fs_store.origin.local_origin import local_origin_for_path  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    def extract(ref: FSRef, resolved_id: str) -> list:
        info = SchemaRegistry.get(type_name)   # a dict hit; the info may be enriched after registration
        root = info.layout_of(ref._path, verify=True).root
        if root is None:
            return []
        try:
            obj = info.serializer().load(info.entity_cls, local_origin_for_path(root), entity_id=resolved_id)
        except (OSError, UnicodeDecodeError, ValueError, ValidationError, CapsuleError) as exc:
            # Binary under a .md, a rejected manifest, an unreadable file: not
            # this type's record, never the indexer's error counter.
            logger.warning("[%s] %s rejected: %s", type_name, root, exc)
            return []
        # Record emission, not persistence: every declared field rides the
        # record (``from_record`` keeps what the row declares); only the two
        # DB-side denormalizations stay off it.
        blobs = set(obj.get_blob_fields_names())
        fields = {
            k: v
            for k, v in obj.model_dump(mode="json", exclude={"id", "type", "expand", "asset_occurrences"}).items()
            if v is not None and not (k in blobs and v == "")   # an empty blob is absent, never a store
        }
        fields["status"] = fields.get("status") or "active"
        fields["content"] = fts_content(obj, info)
        rec = FSRecord(type=type_name, id=resolved_id, **fields)
        if info.main_layout == "folder":
            rec.asset_ref = FSRef(root.resolve())
        else:
            rec.asset_ref = FrontMatterFsRef(root) if info.main_ext == ".md" else FSRef(root)
        if ref.scope:
            rec.scope = ref.scope
        return [rec]

    extract.__name__ = f"extract_{type_name}"
    return extract
