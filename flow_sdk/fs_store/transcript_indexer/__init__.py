"""TranscriptIndexer: pluggable handlers fired during FSIndexer's CLAUDE_SESSION pass.

The dispatcher iterates parsed `AgentTranscript` entries via the analyzer's own
`filter(kind=..., tool_name=...)` so handler-matcher logic stays in one place.
Handlers are idempotent — a forced reindex replays every entry, and any
persisted side effects (entity creation, private_context_entities append) are
dedup-safe by design.
"""

from .handler import TranscriptContext, TranscriptHandler
from .indexer import TranscriptIndexer

__all__ = ["TranscriptContext", "TranscriptHandler", "TranscriptIndexer"]
