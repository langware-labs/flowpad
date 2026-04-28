"""Backward-compat re-export. Use flow_sdk.fs_records.schema_record instead."""
from flow_sdk.fs_records.schema_record import (
    SchemaRecord as SchemaLog,
)

__all__ = ["SchemaLog"]
