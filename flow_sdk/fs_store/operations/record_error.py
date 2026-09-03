"""Structured error records for indexing failures. Free functions over FSRecord."""
from __future__ import annotations

import shutil
import traceback
from datetime import datetime, timezone

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.record_types import RecordType


def from_exception(record, exc: Exception, trigger: str = "unknown") -> FSRecord:
    """Construct (but don't save) an FSRecord describing an indexing failure."""
    tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
    tb_str = "".join(tb[-3:])
    return FSRecord(
        type=RecordType.RECORD_ERROR,
        id=mint_uuid(),
        source_record_id=getattr(record, "id", None),
        source_record_type=getattr(record, "type", None) or getattr(record, "_record_type", None),
        error_message=str(exc),
        error_type=type(exc).__name__,
        error_traceback=tb_str,
        occurred_at=datetime.now(timezone.utc).isoformat(),
        trigger=trigger,
    )


def _remove(rec: FSRecord) -> None:
    try:
        shutil.rmtree(rec.shadow_dir)
    except (FileNotFoundError, OSError):
        pass


async def clear_all() -> int:
    """Delete every record_error shadow on disk. Returns deletion count."""
    records = FSRecord.discover(RecordType.RECORD_ERROR)
    for rec in records:
        _remove(rec)
    return len(records)


async def clear_for_type(type_name: str) -> int:
    """Delete record_error shadows whose source_record_type == type_name."""
    count = 0
    for rec in FSRecord.discover(RecordType.RECORD_ERROR):
        if rec.__dict__.get("source_record_type") == type_name:
            _remove(rec)
            count += 1
    return count
