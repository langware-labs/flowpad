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
    # Single JSON document (not JSONL): a workflow run journal, wf_<runId>.json.
    WORKFLOW_JOURNAL = "workflow_journal"


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
