"""Transcript entry parsing — minimal generic dispatch.

The original transcript_records package (8 typed entry subclasses + dispatch)
was removed in the Record-cleanup. Production callers (``claude_session_transcript_entries``,
``mcp_api``) read entries lazily from JSONL files for UI display and MCP exports.

This module exposes ``create_transcript_entry`` returning a generic
``TranscriptEntry`` dataclass that preserves the envelope fields used by
downstream callers (``entry_type``, ``summary``, ``entry_uuid``, ``raw``).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


_EXCLUDED_TYPES: frozenset[str] = frozenset({"file-history-snapshot", "progress"})


@dataclass
class TranscriptEntry:
    """A single transcript entry parsed from a session JSONL line."""

    entry_type: str = ""
    entry_uuid: str = ""
    timestamp: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def summary(self) -> str:
        return f"{self.entry_type or '?'} {self.entry_uuid or ''}".strip()

    def to_dict(self) -> dict[str, Any]:
        return {
            "entry_type": self.entry_type,
            "entry_uuid": self.entry_uuid,
            "timestamp": self.timestamp,
            **(self.raw or {}),
        }


def create_transcript_entry(raw: dict[str, Any]) -> TranscriptEntry:
    """Build a generic TranscriptEntry from a raw JSONL dict."""
    return TranscriptEntry(
        entry_type=str(raw.get("type") or ""),
        entry_uuid=str(raw.get("uuid") or ""),
        timestamp=str(raw.get("timestamp") or ""),
        raw=raw,
    )
