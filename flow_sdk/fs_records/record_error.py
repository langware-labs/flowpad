"""RecordError — structured error record for indexing failures."""
from __future__ import annotations

import traceback
import uuid
from datetime import datetime, timezone
from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class RecordError(Record):
    """Structured error record created when indexing fails."""

    _record_type: ClassVar[str] = RecordType.RECORD_ERROR

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("type", "record_error")
        kwargs.setdefault("id", str(uuid.uuid4()))
        super().__init__(**kwargs)

    @classmethod
    def from_exception(
        cls,
        record: Record,
        exc: Exception,
        trigger: str = "unknown",
    ) -> RecordError:
        tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
        tb_str = "".join(tb[-3:])  # truncated
        return cls(
            source_record_id=record.id,
            source_record_type=record.type or record._record_type,
            error_message=str(exc),
            error_type=type(exc).__name__,
            error_traceback=tb_str,
            occurred_at=datetime.now(timezone.utc).isoformat(),
            trigger=trigger,
        )

    @classmethod
    def clear_for_type(cls, type_name: str) -> int:
        count = 0
        for rec in super().discover():  # own records only, not subtypes
            if rec.source_record_type == type_name:
                rec.delete()
                count += 1
        return count

    @classmethod
    def clear_all(cls) -> int:
        count = 0
        for rec in super().discover():  # own records only, not subtypes
            rec.delete()
            count += 1
        return count
