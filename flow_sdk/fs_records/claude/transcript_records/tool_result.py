"""ClaudeToolResultTranscriptEntry — user entry containing a tool_result."""

from __future__ import annotations

from typing import Any
from flow_sdk._compat import Self

from flow_sdk.fs_store import RecordType

from .base import ClaudeTranscriptEntryFsRecord, _truncate


class ClaudeToolResultTranscriptEntry(ClaudeTranscriptEntryFsRecord):
    """A user transcript entry that carries a tool result."""

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.TRANSCRIPT_TOOL_RESULT
        super().__init__(**kwargs)

    # -- tool_result block (first one in content) --

    @property
    def _result_block(self) -> dict:
        for block in self.message.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                return block
        return {}

    @property
    def tool_use_id(self) -> str:
        return self._result_block.get("tool_use_id", "")

    @property
    def search_content(self) -> str:
        """The text content returned by the tool."""
        raw = self._result_block.get("content", "")
        if isinstance(raw, str):
            return raw
        if isinstance(raw, list):
            parts = []
            for block in raw:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))
            return "\n".join(parts)
        return str(raw)

    @property
    def tool_use_result(self) -> dict:
        """Extra tool result metadata from the envelope (filePath, patch, etc.)."""
        return self.raw_json.get("toolUseResult") or {}

    @property
    def file_path(self) -> str:
        return self.tool_use_result.get("filePath", "")

    # -- summary --

    @property
    def is_error(self) -> bool:
        return self._result_block.get("is_error", False)

    @property
    def summary(self) -> str:
        prefix = "ERROR tool_result: " if self.is_error else "tool_result: "
        return prefix + _truncate(self.search_content, 120)

    def __repr__(self) -> str:
        return f"{type(self).__name__}: {self.summary}"

    @classmethod
    def from_jsonl_entry(cls, raw: dict) -> Self:
        return cls(**cls._base_kwargs(raw))


def _is_tool_result_entry(raw: dict) -> bool:
    """Check if a raw JSONL dict is a user entry with a tool_result block."""
    if raw.get("type") != "user":
        return False
    for block in (raw.get("message") or {}).get("content") or []:
        if isinstance(block, dict) and block.get("type") == "tool_result":
            return True
    return False
