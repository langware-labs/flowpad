"""Unified transcript analyzer for agentic workers.

Public surface:
    AgentTranscript(worker_type, path) — parses a transcript JSONL file
                                         into a typed entry stream.
    EntryKind                          — filter tag.
    TranscriptEntry + subclasses       — entry hierarchy.
"""

from .entries import (
    AssistantMessageEntry,
    ExitPlanModeEntry,
    MetaEntry,
    SummaryEntry,
    SystemEntry,
    ToolResultEntry,
    ToolUseEntry,
    UnknownEntry,
    UserMessageEntry,
)
from .entry import EntryKind, TranscriptEntry
from .formats import TranscriptDescriptor, TranscriptFormat, TranscriptSource
from .transcript import AgentTranscript

__all__ = [
    "AgentTranscript",
    "AssistantMessageEntry",
    "EntryKind",
    "ExitPlanModeEntry",
    "MetaEntry",
    "SummaryEntry",
    "SystemEntry",
    "TranscriptDescriptor",
    "ToolResultEntry",
    "ToolUseEntry",
    "TranscriptEntry",
    "TranscriptFormat",
    "TranscriptSource",
    "UnknownEntry",
    "UserMessageEntry",
]
