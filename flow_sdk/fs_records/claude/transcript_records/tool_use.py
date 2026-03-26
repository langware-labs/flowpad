"""ClaudeToolTranscriptEntry — assistant entry containing a tool_use call."""

from __future__ import annotations

from typing import Any, ClassVar
from flow_sdk._compat import Self

from flow_sdk.fs_store import RecordType

from .base import ClaudeTranscriptEntryFsRecord, _truncate


class ClaudeToolTranscriptEntry(ClaudeTranscriptEntryFsRecord):
    """An assistant transcript entry that invokes a tool."""

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.TRANSCRIPT_TOOL_USE
        super().__init__(**kwargs)

    # -- tool_use block (first one in content) --

    @property
    def _tool_block(self) -> dict:
        for block in self.message.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                return block
        return {}

    @property
    def tool_name(self) -> str:
        return self._tool_block.get("name", "")

    @property
    def tool_use_id(self) -> str:
        return self._tool_block.get("id", "")

    @property
    def tool_input(self) -> dict:
        return self._tool_block.get("input") or {}

    # -- envelope fields --

    @property
    def model(self) -> str:
        return self.message.get("model", "")

    @property
    def request_id(self) -> str:
        return self.raw_json.get("requestId", "")

    # -- Tools that should show full input values (no truncation) --
    _FULL_INPUT_TOOLS: ClassVar[set[str]] = {"Read", "Write", "TaskCreate"}

    # -- summary --

    @property
    def summary(self) -> str:
        inp = self.tool_input
        name = self.tool_name
        full = name in self._FULL_INPUT_TOOLS
        if inp:
            parts = []
            for k, v in inp.items():
                s = str(v)
                if not full and len(s) > 120:
                    s = s[:120] + "..."
                parts.append(f"{k}={s}")
            args = ", ".join(parts)
        else:
            args = ""
        line = f"{name}({args})"
        if full:
            return "tool: " + line
        return "tool: " + _truncate(line)

    def __repr__(self) -> str:
        return f"{type(self).__name__}: {self.summary}"

    @classmethod
    def from_jsonl_entry(cls, raw: dict) -> Self:
        return cls(**cls._base_kwargs(raw))


def _is_tool_use_entry(raw: dict) -> bool:
    """Check if a raw JSONL dict is an assistant entry with a tool_use block."""
    if raw.get("type") != "assistant":
        return False
    for block in (raw.get("message") or {}).get("content") or []:
        if isinstance(block, dict) and block.get("type") == "tool_use":
            return True
    return False
