"""ClaudePrLinkTranscriptEntry — pr-link entry."""

from __future__ import annotations

from typing import Any, ClassVar, Self

from flow_sdk.fs_store import RecordType

from .base import ClaudeTranscriptEntryFsRecord


class ClaudePrLinkTranscriptEntry(ClaudeTranscriptEntryFsRecord):
    """A pr-link transcript entry.

    Uses ``sessionId`` as the uid since these entries have no ``uuid``.
    """

    uid_mapping: ClassVar[str] = "sessionId"

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.TRANSCRIPT_PR_LINK
        super().__init__(**kwargs)

    @property
    def pr_number(self) -> int:
        return self.raw_json.get("prNumber", 0)

    @property
    def pr_url(self) -> str:
        return self.raw_json.get("prUrl", "")

    @property
    def pr_repository(self) -> str:
        return self.raw_json.get("prRepository", "")

    @property
    def summary(self) -> str:
        return f"PR #{self.pr_number} — {self.pr_url}"

    def __repr__(self) -> str:
        return f"{type(self).__name__}: {self.summary}"

    @classmethod
    def from_jsonl_entry(cls, raw: dict) -> Self:
        return cls(**cls._base_kwargs(raw))
