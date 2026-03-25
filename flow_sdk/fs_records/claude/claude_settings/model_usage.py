"""ClaudeModelUsageFsRecord -- per-model token usage within a project."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeModelUsageFsRecord(Record):
    """Token usage for a specific model within a project."""

    _record_type: ClassVar[str] = RecordType.CLAUDE_SETTINGS_MODEL_USAGE

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_SETTINGS_MODEL_USAGE
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @property
    def total_tokens(self) -> int:
        """Total tokens (input + output)."""
        return self.input_tokens + self.output_tokens

    @classmethod
    def from_raw(cls, model_id: str, data: dict) -> ClaudeModelUsageFsRecord:
        """Create from a lastModelUsage entry."""
        rec = cls(
            model_id=model_id,
            input_tokens=data.get("inputTokens", 0),
            output_tokens=data.get("outputTokens", 0),
            cache_read_input_tokens=data.get("cacheReadInputTokens", 0),
            cache_creation_input_tokens=data.get("cacheCreationInputTokens", 0),
            web_search_requests=data.get("webSearchRequests", 0),
            cost_usd=data.get("costUSD", 0.0),
        )
        rec.id = model_id
        rec.name = model_id
        return rec
