"""Transcript format/source enums shared by drivers and analyzers."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from flow_sdk._compat import StrEnum


class TranscriptFormat(StrEnum):
    """Native JSONL/event-log shape used to parse a transcript."""

    CLAUDE_JSONL = "claude_jsonl"
    CODEX_STREAM = "codex_stream"
    CODEX_ROLLOUT = "codex_rollout"
    COPILOT_STREAM = "copilot_stream"
    COPILOT_EVENTS = "copilot_events"
    # OpenCode's own store is one JSON file per message, so there is nothing
    # tail-readable to point at: FlowPad owns the canonical JSONL in both modes.
    # STREAM is the headless stdout tee; SESSION is the projection assembled
    # from the vendor store for PTY sessions. Both carry the same line
    # vocabulary, so one parser serves both.
    OPENCODE_STREAM = "opencode_stream"
    OPENCODE_SESSION = "opencode_session"


class TranscriptSource(StrEnum):
    """Where the transcript file was resolved from."""

    PROCESS_LOCAL = "process_local"
    WORKER_SESSION = "worker_session"


@dataclass(frozen=True)
class TranscriptDescriptor:
    """Resolved transcript file plus the parser metadata needed for it."""

    path: Path
    format: TranscriptFormat
    source: TranscriptSource
    session_id: str = ""
    # True when ``path`` is a FlowPad-materialised projection of some other
    # store rather than the file the worker itself appends to. A live poller
    # must RE-RESOLVE such a transcript every tick — watching the projection's
    # own mtime only ever reports the last time FlowPad rewrote it, so a
    # resolve-once loop would never observe a single new entry.
    derived: bool = False

    def to_dict(self) -> dict[str, str]:
        return {
            "path": str(self.path),
            "format": self.format.value,
            "source": self.source.value,
            "session_id": self.session_id,
        }


__all__ = [
    "TranscriptDescriptor",
    "TranscriptFormat",
    "TranscriptSource",
]
