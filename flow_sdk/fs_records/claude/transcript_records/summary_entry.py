"""ClaudeSummaryTranscriptEntry — summary entry."""

from __future__ import annotations

from typing import Any, ClassVar
from flow_sdk._compat import Self

from flow_sdk.fs_store import RecordType

from .base import ClaudeTranscriptEntryFsRecord, _truncate


class ClaudeSummaryTranscriptEntry(ClaudeTranscriptEntryFsRecord):
    """A summary transcript entry (session auto-summary).

    Uses ``leafUuid`` as the uid since these entries have no ``uuid``.
    """

    uid_mapping: ClassVar[str] = "leafUuid"

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.TRANSCRIPT_SUMMARY
        super().__init__(**kwargs)

    @property
    def leaf_uuid(self) -> str:
        return self.raw_json.get("leafUuid", "")

    @property
    def summary_text(self) -> str:
        return self.raw_json.get("summary", "")

    @property
    def summary(self) -> str:
        return "summary: " + _truncate(self.summary_text)

    def __repr__(self) -> str:
        return f"{type(self).__name__}: {self.summary}"

    @classmethod
    def from_jsonl_entry(cls, raw: dict) -> Self:
        return cls(**cls._base_kwargs(raw))
