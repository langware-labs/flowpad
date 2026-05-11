"""Unified transcript analyzer for agentic workers.

Public surface:
    AgentTranscript(worker_type, path) — parses a transcript JSONL file
                                         into a typed entry stream.
    EntryKind                          — filter tag.
    TranscriptEntry + subclasses       — entry hierarchy.
"""

from .entries import (
    AgentSpawnEntry,
    AssistantMessageEntry,
    ExitPlanModeEntry,
    FileEditEntry,
    FileReadEntry,
    FileWriteEntry,
    MetaEntry,
    SearchEntry,
    ShellCommandEntry,
    SummaryEntry,
    SystemEntry,
    TodoUpdateEntry,
    ToolResultEntry,
    ToolUseEntry,
    UnknownEntry,
    UserMessageEntry,
    WebFetchEntry,
)
from .entry import EntryKind, TranscriptEntry
from .formats import TranscriptDescriptor, TranscriptFormat, TranscriptSource
from .process_entry import ObservationKind, ProcessEntry
from .transcript import AgentTranscript

__all__ = [
    "AgentTranscript",
    "AgentSpawnEntry",
    "AssistantMessageEntry",
    "EntryKind",
    "ExitPlanModeEntry",
    "FileEditEntry",
    "FileReadEntry",
    "FileWriteEntry",
    "MetaEntry",
    "ObservationKind",
    "ProcessEntry",
    "SearchEntry",
    "ShellCommandEntry",
    "SummaryEntry",
    "SystemEntry",
    "TodoUpdateEntry",
    "ToolResultEntry",
    "ToolUseEntry",
    "TokenUsageEntry",
    "TranscriptDescriptor",
    "TranscriptEntry",
    "TranscriptFormat",
    "TranscriptSource",
    "UnknownEntry",
    "UserMessageEntry",
    "WebFetchEntry",
]
