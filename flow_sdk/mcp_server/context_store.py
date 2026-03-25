"""Simple in-memory key-value stores for MCP session context."""

from __future__ import annotations

import threading
from typing import Any


class ContextStore:
    """Thread-safe in-memory key-value store keyed by (session_id, key)."""

    def __init__(self) -> None:
        self._data: dict[tuple[str, str], str] = {}
        self._lock = threading.Lock()

    def set(self, session_id: str, key: str, value: str) -> str:
        with self._lock:
            self._data[(session_id, key)] = value
        return f"Set {key}"

    def get(self, session_id: str, key: str) -> str:
        with self._lock:
            val = self._data.get((session_id, key))
        if val is None:
            return f"Error: key '{key}' not found for session {session_id}"
        return val
