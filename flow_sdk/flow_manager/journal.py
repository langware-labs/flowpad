"""Flow journal — append-only JSONL of routed events + in-memory ring buffer.

Events are ephemeral traffic, not entities: the journal is the observability
and postmortem substrate (trigger_log pattern). Storage:
``<records_root>/flow_journal/events.jsonl``.
"""
from __future__ import annotations

import json
import logging
from collections import deque
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

RING_SIZE = 500
MAX_FILE_ENTRIES = 5000
DROP_COUNT = 1000


def _journal_file() -> Path:
    from flow_sdk.instance_settings import get_instance_settings

    return get_instance_settings().records_root / "flow_journal" / "events.jsonl"


class FlowJournal:
    def __init__(self) -> None:
        self._ring: deque[dict[str, Any]] = deque(maxlen=RING_SIZE)
        # Compaction cadence: checking file size means reading the whole file,
        # so only do it once per DROP_COUNT appends (and on the first append,
        # to handle a large pre-existing file).
        self._appends_until_compact_check = 0

    def append(self, entry: dict[str, Any]) -> None:
        self._ring.append(entry)
        try:
            path = _journal_file()
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")
            self._appends_until_compact_check -= 1
            if self._appends_until_compact_check <= 0:
                self._appends_until_compact_check = DROP_COUNT
                self._compact_if_needed(path)
        except Exception:
            logger.debug("FlowJournal: disk append failed", exc_info=True)

    def tail(self, limit: int = 200, correlation_id: str | None = None) -> list[dict[str, Any]]:
        entries = list(self._ring)
        if correlation_id:
            entries = [e for e in entries if e.get("correlation_id") == correlation_id]
        return entries[-limit:]

    @staticmethod
    def _compact_if_needed(path: Path) -> None:
        """Cap the file: when over MAX_FILE_ENTRIES lines, drop the oldest chunk."""
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
            if len(lines) > MAX_FILE_ENTRIES:
                path.write_text("\n".join(lines[DROP_COUNT:]) + "\n", encoding="utf-8")
        except Exception:
            logger.debug("FlowJournal: compaction failed", exc_info=True)
