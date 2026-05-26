"""``Parser`` Protocol — what every per-worker parser implements.

Stateful by design: a parser instance is owned by one ``AgentTranscriptFile``
parse and may cache cross-line state (e.g. codex caches ``thread_id`` from
``thread.started`` to populate ``session_id`` on subsequent lines).
"""

from __future__ import annotations

from typing import Protocol

from ..entry import TranscriptEntry


class Parser(Protocol):
    worker_type: str
    session_id: str  # populated lazily by lines that carry it; "" until then

    def feed(self, raw: dict, line_index: int) -> list[TranscriptEntry]:
        """Translate one raw JSONL dict into zero or more entries.

        Most lines yield exactly one entry; codex synthesizes a
        ``ToolUseEntry`` + ``ToolResultEntry`` pair from a single
        ``item.completed:command_execution`` line. Unrecognized lines yield
        a single ``UnknownEntry`` (which warns on construction).
        """
        ...
