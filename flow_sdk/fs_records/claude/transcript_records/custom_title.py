"""ClaudeCustomTitleTranscriptEntry — custom-title entry."""

from __future__ import annotations

from typing import Any, ClassVar, Self

from flow_sdk.fs_store import RecordType

from .base import ClaudeTranscriptEntryFsRecord, _truncate


class ClaudeCustomTitleTranscriptEntry(ClaudeTranscriptEntryFsRecord):
    """A custom-title transcript entry.

    Uses ``sessionId`` as the uid since these entries have no ``uuid``.
    """

    uid_mapping: ClassVar[str] = "sessionId"

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.TRANSCRIPT_CUSTOM_TITLE
        super().__init__(**kwargs)

    @property
    def custom_title(self) -> str:
        return self.raw_json.get("customTitle", "")

    @property
    def summary(self) -> str:
        return "title: " + _truncate(self.custom_title)

    def __repr__(self) -> str:
        return f"{type(self).__name__}: {self.summary}"

    @classmethod
    def from_jsonl_entry(cls, raw: dict) -> Self:
        return cls(**cls._base_kwargs(raw))
