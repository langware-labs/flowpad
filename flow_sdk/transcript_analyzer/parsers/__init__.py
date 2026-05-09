"""Per-worker parser registry."""

from __future__ import annotations

from .base import Parser
from .claude import ClaudeParser
from .codex import CodexParser, CodexRolloutParser, CodexStreamParser
from ..formats import TranscriptFormat

_REGISTRY: dict[str, type[Parser]] = {
    "claude": ClaudeParser,
    "codex": CodexParser,
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
    "get_parser_class",
]
