"""Claude error records — fingerprint-deduplicated triage records.

Free-function module over ``FSRecord(type='claude_error')``. Exposes:
- ``ErrorStatus`` / ``ErrorCategory`` enums
- ``Fix`` value object (cloud fix suggestion)
- ``get_by_fingerprint(fp)`` lookup
- ``sync_from_debug_logs(...)`` placeholder (full impl deferred)
"""
from __future__ import annotations

import uuid
from typing import Any

from flow_sdk._compat import StrEnum
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.api.api_types.identifier import mint_uuid

# CRUD-only type (no walker): lets GET /fs-records/claude_error return an empty
# list instead of 400. Records are upserted on demand from debug logs.
SchemaRegistry.register_crud_type(RecordType.CLAUDE_ERROR, icon="AlertTriangle")


class ErrorStatus(StrEnum):
    OPEN = "open"
    IGNORED = "ignored"
    IGNORED_UNTIL = "ignored_until"
    TASK_CREATED = "task_created"


class ErrorCategory(StrEnum):
    HOOK = "hook"
    LOG = "log"


class Fix:
    """Cloud fix suggestion (instruction + message)."""

    __slots__ = ("instruction", "message")

    def __init__(self, instruction: str = "", message: str = "") -> None:
        self.instruction = instruction or ""
        self.message = message or ""

    def to_dict(self) -> dict:
        return {"instruction": self.instruction, "message": self.message}

    @classmethod
    def from_dict(cls, d: object) -> "Fix":
        if isinstance(d, dict):
            return cls(d.get("instruction") or "", d.get("message") or "")
        return cls()


def _rec_id_for_fingerprint(fingerprint: str) -> str:
    return mint_uuid(f"{RecordType.CLAUDE_ERROR}:{fingerprint}", namespace=uuid.NAMESPACE_DNS)


def get_by_fingerprint(fingerprint: str) -> FSRecord | None:
    """Return the FSRecord for this fingerprint, or None if absent."""
    return FSRecord.load_or_none(RecordType.CLAUDE_ERROR, _rec_id_for_fingerprint(fingerprint))


def sync_from_debug_logs(*args: Any, **kwargs: Any) -> dict:
    """Parse ~/.claude/debug/*.txt and upsert claude_error records.

    NOT YET RESTORED. Returns an empty summary.
    """
    return {"synced": 0, "skipped": 0, "errors": 0}
