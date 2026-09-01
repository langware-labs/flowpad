"""Test helper: store an entity's asset through its type's serializer — what
``FSRecord.upsert_main_ref`` used to do for the tests that named it."""
from __future__ import annotations

from flow_sdk.fs_store.origin.local_origin import local_origin_for_path
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def store_main(rec, entity, *, force: bool = False) -> str | None:
    """Write ``entity``'s main doc at ``rec``'s asset root; the record adopts the committed id."""
    info = SchemaRegistry.get(rec.type)
    origin = local_origin_for_path(info.storage_root_for(rec._asset_ref._path))
    committed = info.serializer().store(entity, origin, type_name=rec.type, force=force)
    if committed.id:
        rec.__dict__["id"] = committed.id
    return committed.id or None
