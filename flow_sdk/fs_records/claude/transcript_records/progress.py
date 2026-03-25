"""ClaudeProgressTranscriptEntry — progress entry from a Claude Code session.

Progress entries carry streaming updates in their ``data`` dict.
Dynamic properties expose the data fields based on ``progress_type``.
"""

from __future__ import annotations

from typing import Any, Self

from flow_sdk.fs_store import RecordType

from .base import ClaudeTranscriptEntryFsRecord


class ClaudeProgressTranscriptEntry(ClaudeTranscriptEntryFsRecord):
    """A progress transcript entry with dynamic props from ``data``."""

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.TRANSCRIPT_PROGRESS
        super().__init__(**kwargs)

    # -- Common progress fields --

    @property
    def progress_type(self) -> str:
        """The data sub-type: hook_progress, bash_progress, tool_use, etc."""
        return self.data.get("type", "")

    @property
    def tool_use_id(self) -> str:
        return self.raw_json.get("toolUseID", "")

    @property
    def parent_tool_use_id(self) -> str:
        return self.raw_json.get("parentToolUseID", "")

    # -- hook_progress fields --

    @property
    def hook_event(self) -> str:
        """Hook event name (e.g. SessionStart, PreToolUse)."""
        return self.data.get("hookEvent", "")

    @property
    def hook_name(self) -> str:
        """Hook identifier (e.g. SessionStart:clear)."""
        return self.data.get("hookName", "")

    @property
    def command(self) -> str:
        """Shell command executed by the hook."""
        return self.data.get("command", "")

    # -- summary override --

    @property
    def summary(self) -> str:
        pt = self.progress_type
        if pt == "hook_progress":
            return f"progress: {self.hook_event} ({self.hook_name})"
        return f"progress: {pt}"

    def __repr__(self) -> str:
        return f"{type(self).__name__}: {self.summary}"

    @classmethod
    def from_jsonl_entry(cls, raw: dict) -> Self:
        return cls(**cls._base_kwargs(raw))
