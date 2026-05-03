"""Per-worker parser registry."""

from __future__ import annotations

from .base import Parser
from .claude import ClaudeParser
from .codex import CodexParser

_REGISTRY: dict[str, type[Parser]] = {
    "claude": ClaudeParser,
    "codex": CodexParser,
}


def get_parser_class(worker_type: str) -> type[Parser]:
    """Return the ``Parser`` subclass registered for ``worker_type``."""
    try:
        return _REGISTRY[worker_type]
    except KeyError as exc:
        known = sorted(_REGISTRY)
        raise ValueError(
            f"transcript_analyzer: unknown worker_type {worker_type!r} (known: {known})"
        ) from exc


__all__ = ["Parser", "ClaudeParser", "CodexParser", "get_parser_class"]
