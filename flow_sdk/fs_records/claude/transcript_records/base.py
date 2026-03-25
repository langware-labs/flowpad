"""ClaudeTranscriptEntryFsRecord — base entry from a Claude Code session JSONL.

Each line in the session transcript is a JSON object with a shared envelope
(sessionId, cwd, version, uuid, timestamp, type) plus a type-specific payload.
"""

from __future__ import annotations

from typing import Any, ClassVar, Self

from flow_sdk.fs_store import Record, RecordType


def _resolve_json_path(data: dict, path: str) -> Any:
    """Resolve a dot-separated path against a nested dict.

    ``"messageId"`` -> ``data["messageId"]``
    ``"snapshot.messageId"`` -> ``data["snapshot"]["messageId"]``
    """
    for key in path.split("."):
        if not isinstance(data, dict):
            return None
        data = data.get(key)
        if data is None:
            return None
    return data


class ClaudeTranscriptEntryFsRecord(Record):
    """A single entry parsed from a Claude Code session JSONL transcript."""

    uid_mapping: ClassVar[str] = "uuid"

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.TRANSCRIPT_ENTRY
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))
        if self.entry_uuid:
            self.id = self.entry_uuid
        else:
            import warnings
            warnings.warn(
                f"Transcript entry has no uuid mapping -- "
                f"type={self.entry_type!r}, using auto-generated id",
                stacklevel=2,
            )

    def __repr__(self) -> str:
        return f"{type(self).__name__}: {self.summary}"

    # Override Record.data property to return the entry's "data" domain field.
    @property
    def data(self) -> dict:
        """The entry's data payload (from the JSONL ``data`` field)."""
        d = object.__getattribute__(self, "__dict__")
        val = d.get("data_field")
        return val if isinstance(val, dict) else {}

    @data.setter
    def data(self, value: dict | None) -> None:
        object.__setattr__(self, "data_field", value if value is not None else {})
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("data_field")

    @property
    def entry_type(self) -> str:
        return object.__getattribute__(self, "__dict__").get("entry_type", "") or ""

    @property
    def entry_uuid(self) -> str:
        return object.__getattribute__(self, "__dict__").get("entry_uuid", "") or ""

    @property
    def message(self) -> dict:
        val = object.__getattribute__(self, "__dict__").get("message")
        return val if isinstance(val, dict) else {}

    @property
    def summary(self) -> str:
        """Return a one-line textual summary of this transcript entry."""
        handler = _SUMMARY_HANDLERS.get(self.entry_type, _summary_unknown)
        return handler(self)

    @classmethod
    def _base_kwargs(cls, raw: dict) -> dict:
        """Extract common envelope fields from a raw JSONL dict."""
        return dict(
            entry_type=raw.get("type", ""),
            subtype=raw.get("subtype", ""),
            entry_uuid=_resolve_json_path(raw, cls.uid_mapping) or "",
            timestamp=raw.get("timestamp", ""),
            session_id=raw.get("sessionId", ""),
            parent_uuid=raw.get("parentUuid") or "",
            is_sidechain=raw.get("isSidechain", False),
            message=raw.get("message") or {},
            data=raw.get("data") or {},
            raw_json=raw,
        )

    @classmethod
    def from_jsonl_entry(cls, raw: dict) -> Self:
        """Create a record from a parsed JSONL line."""
        return cls(**cls._base_kwargs(raw))


# ---------------------------------------------------------------------------
# Summary handlers -- one per entry_type
# ---------------------------------------------------------------------------

def _truncate(text: str, limit: int = 80) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "..."


def _extract_text(content: Any) -> str:
    """Extract plain text from a message content field."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(block.get("text", ""))
                elif block.get("type") == "tool_result":
                    tool_id = block.get("tool_use_id", "?")
                    parts.append(f"[tool_result for {tool_id}]")
                elif block.get("type") == "tool_use":
                    name = block.get("name", "?")
                    inp = block.get("input", {})
                    inp_summary = _summarize_input(inp)
                    parts.append(f"tool: {name}({inp_summary})")
                elif block.get("type") == "thinking":
                    parts.append("[thinking]")
        return " | ".join(parts) if parts else str(content)
    return str(content)


def _summarize_input(inp: Any) -> str:
    """Produce a short summary of tool input."""
    if isinstance(inp, dict):
        keys = list(inp.keys())[:3]
        return ", ".join(keys)
    return str(inp)[:40]


def _summary_user(entry: ClaudeTranscriptEntryFsRecord) -> str:
    content = entry.message.get("content", "")
    return "user: " + _truncate(_extract_text(content))


def _summary_assistant(entry: ClaudeTranscriptEntryFsRecord) -> str:
    content = entry.message.get("content", "")
    text = _extract_text(content)
    return "assistant: " + _truncate(text)


def _summary_system(entry: ClaudeTranscriptEntryFsRecord) -> str:
    sub = entry.subtype
    raw = entry.raw_json
    if sub == "turn_duration":
        ms = raw.get("durationMs", "?")
        return f"turn completed in {ms}ms"
    if sub == "stop_hook_summary":
        count = raw.get("hookCount", "?")
        return f"stop hooks ran ({count} hooks)"
    if sub == "compact_boundary":
        tokens = raw.get("tokens", "?")
        return f"context compacted at {tokens} tokens"
    if sub == "api_error":
        error = raw.get("error", "?")
        return f"API error: {error}"
    return f"system:{sub or '?'}"


def _summary_progress(entry: ClaudeTranscriptEntryFsRecord) -> str:
    data_type = entry.data.get("type", "?")
    return f"progress: {data_type}"


def _summary_file_history(entry: ClaudeTranscriptEntryFsRecord) -> str:
    return "file snapshot"


def _summary_queue_operation(entry: ClaudeTranscriptEntryFsRecord) -> str:
    op = entry.raw_json.get("operation", "?")
    return f"queue: {op}"


def _summary_summary(entry: ClaudeTranscriptEntryFsRecord) -> str:
    text = entry.raw_json.get("summary", "")
    return "summary: " + _truncate(text)


def _summary_unknown(entry: ClaudeTranscriptEntryFsRecord) -> str:
    return f"[{entry.entry_type}]"


_SUMMARY_HANDLERS: dict[str, Any] = {
    "user": _summary_user,
    "assistant": _summary_assistant,
    "system": _summary_system,
    "progress": _summary_progress,
    "file-history-snapshot": _summary_file_history,
    "queue-operation": _summary_queue_operation,
    "summary": _summary_summary,
}
