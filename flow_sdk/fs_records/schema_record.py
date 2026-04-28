"""Backward compat shim: SchemaRecord = SchemaRegistry.

All implementation has moved to flow_sdk.fs_store.schema_registry.
"""
from flow_sdk.fs_store.schema_registry import (
    SchemaRegistry as SchemaRecord,
    ScanResult as ScanResult,
    IndexResult as IndexResult,
    IndexRequest as IndexRequest,
    ClearResult as ClearResult,
    TypeIndexStatus as TypeIndexStatus,
    IndexStatus as IndexStatus,
    _sanitize_type_name as _sanitize_type_name,
    _append_jsonl as _append_jsonl,
    _trim_jsonl as _trim_jsonl,
    _read_last_entry as _read_last_entry,
)

__all__ = [
    "SchemaRecord",
    "ScanResult",
    "IndexResult",
    "IndexRequest",
    "ClearResult",
    "TypeIndexStatus",
    "IndexStatus",
    "_sanitize_type_name",
    "_append_jsonl",
    "_trim_jsonl",
    "_read_last_entry",
]
