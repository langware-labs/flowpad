"""ClaudeQueueOperationTranscriptEntry — queue-operation entry."""

from __future__ import annotations

from typing import Any, ClassVar, Self

from flow_sdk.fs_store import RecordType

from .base import ClaudeTranscriptEntryFsRecord


class ClaudeQueueOperationTranscriptEntry(ClaudeTranscriptEntryFsRecord):
    """A queue-operation transcript entry (enqueue/dequeue).

    Uses ``sessionId`` as the uid since these entries have no ``uuid``.
    """

    uid_mapping: ClassVar[str] = "sessionId"

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.TRANSCRIPT_QUEUE_OPERATION
        super().__init__(**kwargs)

    @property
    def operation(self) -> str:
        return self.raw_json.get("operation", "")

    @property
    def search_content(self) -> str:
        return self.raw_json.get("content", "")

    @property
    def summary(self) -> str:
        op = self.operation
        if self.search_content:
            return f"queue: {op} — {self.search_content[:60]}"
        return f"queue: {op}"

    def __repr__(self) -> str:
        return f"{type(self).__name__}: {self.summary}"

    @classmethod
    def from_jsonl_entry(cls, raw: dict) -> Self:
        return cls(**cls._base_kwargs(raw))
