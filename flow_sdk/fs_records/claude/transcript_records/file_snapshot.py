"""ClaudeFileSnapshotTranscriptEntry — file-history-snapshot entry."""

from __future__ import annotations

from typing import Any, ClassVar, Self

from flow_sdk.fs_store import RecordType

from .base import ClaudeTranscriptEntryFsRecord


class ClaudeFileSnapshotTranscriptEntry(ClaudeTranscriptEntryFsRecord):
    """A file-history-snapshot transcript entry.

    Uses ``messageId`` as the uid instead of ``uuid``.
    """

    uid_mapping: ClassVar[str] = "messageId"

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.TRANSCRIPT_FILE_SNAPSHOT
        super().__init__(**kwargs)

    @property
    def message_id(self) -> str:
        return self.raw_json.get("messageId", "")

    @property
    def snapshot(self) -> dict:
        return self.raw_json.get("snapshot") or {}

    @property
    def is_snapshot_update(self) -> bool:
        return self.raw_json.get("isSnapshotUpdate", False)

    @property
    def summary(self) -> str:
        update = " (update)" if self.is_snapshot_update else ""
        return f"file snapshot{update}"

    def __repr__(self) -> str:
        return f"{type(self).__name__}: {self.summary}"

    @classmethod
    def from_jsonl_entry(cls, raw: dict) -> Self:
        return cls(**cls._base_kwargs(raw))
