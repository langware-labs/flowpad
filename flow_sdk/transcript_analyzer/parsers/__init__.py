"""Per-worker parser registry."""

from __future__ import annotations

from ..formats import TranscriptFormat
from .base import Parser
from .claude import ClaudeParser
from .codex import CodexParser, CodexRolloutParser, CodexStreamParser
from .copilot import CopilotEventsParser, CopilotParser, CopilotStreamParser
from .workflow import WorkflowParser

_REGISTRY: dict[str, type[Parser]] = {
    "claude": ClaudeParser,
    "codex": CodexParser,
    "copilot": CopilotParser,
    "workflow": WorkflowParser,
}


def get_parser_class(
    worker_type: str,
    transcript_format: TranscriptFormat | str | None = None,
) -> type[Parser]:
    """Return the ``Parser`` subclass registered for ``worker_type``."""
    fmt = TranscriptFormat(transcript_format) if transcript_format else None
    if worker_type == "codex":
        if fmt is TranscriptFormat.CODEX_ROLLOUT:
            return CodexRolloutParser
        if fmt is TranscriptFormat.CODEX_STREAM:
            return CodexStreamParser
    if worker_type == "copilot":
        if fmt is TranscriptFormat.COPILOT_EVENTS:
            return CopilotEventsParser
        if fmt is TranscriptFormat.COPILOT_STREAM:
            return CopilotStreamParser
    try:
        return _REGISTRY[worker_type]
    except KeyError as exc:
        known = sorted(_REGISTRY)
        raise ValueError(
            f"transcript_analyzer: unknown worker_type {worker_type!r} (known: {known})"
        ) from exc


__all__ = [
    "Parser",
    "ClaudeParser",
    "CodexParser",
    "CodexRolloutParser",
    "CodexStreamParser",
    "CopilotEventsParser",
    "CopilotParser",
    "CopilotStreamParser",
    "WorkflowParser",
    "get_parser_class",
]
