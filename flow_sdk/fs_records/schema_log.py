"""Backward-compat re-export. Use flow_sdk.fs_records.schema_record instead."""
from flow_sdk.fs_records.schema_record import (
    SchemaRecord as SchemaLog,
    ScanLogEntry,
    IndexLogEntry,
    SCHEMA_DIR,
)

__all__ = ["SchemaLog", "ScanLogEntry", "IndexLogEntry", "SCHEMA_DIR"]
