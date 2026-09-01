"""Per-worker parser registry."""

from __future__ import annotations

from ..formats import TranscriptFormat
from .base import Parser
from .claude import ClaudeParser
from .codex import CodexParser, CodexRolloutParser, CodexStreamParser
from .copilot import CopilotEventsParser, CopilotParser, CopilotStreamParser
from .opencode import OpenCodeParser, OpenCodeSessionParser, OpenCodeStreamParser
from .workflow import WorkflowParser

_REGISTRY: dict[str, type[Parser]] = {
    "claude": ClaudeParser,
    "codex": CodexParser,
    "copilot": CopilotParser,
    "opencode": OpenCodeParser,
    "workflow": WorkflowParser,
}


# A format-specific parser, when the format names one (a format belongs to one
# vendor by construction); a bare worker_type resolves through ``_REGISTRY``.
_BY_FORMAT: dict[TranscriptFormat, type[Parser]] = {
    TranscriptFormat.CODEX_ROLLOUT: CodexRolloutParser,
    TranscriptFormat.CODEX_STREAM: CodexStreamParser,
    TranscriptFormat.COPILOT_EVENTS: CopilotEventsParser,
    TranscriptFormat.COPILOT_STREAM: CopilotStreamParser,
    TranscriptFormat.OPENCODE_SESSION: OpenCodeSessionParser,
    TranscriptFormat.OPENCODE_STREAM: OpenCodeStreamParser,
}


def get_parser_class(
    worker_type: str,
    transcript_format: TranscriptFormat | str | None = None,
) -> type[Parser]:
    """Return the ``Parser`` subclass registered for ``worker_type``."""
    if transcript_format:
        parser = _BY_FORMAT.get(TranscriptFormat(transcript_format))
        if parser is not None:
            return parser
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
    "OpenCodeParser",
    "OpenCodeSessionParser",
    "OpenCodeStreamParser",
    "WorkflowParser",
    "get_parser_class",
]
