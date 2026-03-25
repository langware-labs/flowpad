"""Transcript record types and factory.

``create_transcript_entry`` dispatches on ``type`` (and content) to return
the most specific subclass available, falling back to the base record.
"""

from .base import ClaudeTranscriptEntryFsRecord
from .progress import ClaudeProgressTranscriptEntry
from .tool_use import ClaudeToolTranscriptEntry, _is_tool_use_entry
from .tool_result import ClaudeToolResultTranscriptEntry, _is_tool_result_entry
from .file_snapshot import ClaudeFileSnapshotTranscriptEntry
from .queue_operation import ClaudeQueueOperationTranscriptEntry
from .summary_entry import ClaudeSummaryTranscriptEntry
from .custom_title import ClaudeCustomTitleTranscriptEntry
from .pr_link import ClaudePrLinkTranscriptEntry

# Registry: entry_type -> subclass (simple type-based dispatch)
_ENTRY_TYPE_REGISTRY: dict[str, type[ClaudeTranscriptEntryFsRecord]] = {
    "progress": ClaudeProgressTranscriptEntry,
    "file-history-snapshot": ClaudeFileSnapshotTranscriptEntry,
    "queue-operation": ClaudeQueueOperationTranscriptEntry,
    "summary": ClaudeSummaryTranscriptEntry,
    "custom-title": ClaudeCustomTitleTranscriptEntry,
    "pr-link": ClaudePrLinkTranscriptEntry,
}


def create_transcript_entry(raw: dict) -> ClaudeTranscriptEntryFsRecord:
    """Factory — pick the right subclass for a raw JSONL dict."""
    entry_type = raw.get("type", "")

    # Content-based dispatch (checked before the simple registry)
    if _is_tool_use_entry(raw):
        return ClaudeToolTranscriptEntry.from_jsonl_entry(raw)
    if _is_tool_result_entry(raw):
        return ClaudeToolResultTranscriptEntry.from_jsonl_entry(raw)

    cls = _ENTRY_TYPE_REGISTRY.get(entry_type, ClaudeTranscriptEntryFsRecord)
    return cls.from_jsonl_entry(raw)
