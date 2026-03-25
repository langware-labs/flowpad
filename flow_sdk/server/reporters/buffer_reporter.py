"""
Buffer reporter - stores hook events in memory.
"""

import asyncio
import threading
from typing import Dict, Any, List
from .base import BaseReporter


class BufferReporter(BaseReporter):
    """
    Reporter that stores hook events in an in-memory buffer.

    Features:
    - Thread-safe buffer operations (sync and async)
    - Configurable max buffer size
    - FIFO eviction when buffer is full
    """

    def __init__(self, max_size: int = 100):
        """
        Initialize the buffer reporter.

        Args:
            max_size: Maximum number of events to store (default: 100)
        """
        self._buffer: List[Dict[str, Any]] = []
        self._async_lock = asyncio.Lock()
        self._sync_lock = threading.Lock()
        self._max_size = max_size

    async def report(self, event: Dict[str, Any]) -> None:
        """
        Store event in the buffer.

        Args:
            event: Hook event data dictionary
        """
        async with self._async_lock:
            self._buffer.append(event)
            # Evict oldest if over max size
            if len(self._buffer) > self._max_size:
                self._buffer.pop(0)

    async def get_recent(self) -> List[Dict[str, Any]]:
        """
        Get all events in the buffer.

        Returns:
            Copy of the buffer contents
        """
        async with self._async_lock:
            return self._buffer.copy()

    def get_recent_sync(self) -> List[Dict[str, Any]]:
        """
        Synchronous version of get_recent for non-async contexts.

        Returns:
            Copy of the buffer contents
        """
        with self._sync_lock:
            return self._buffer.copy()

    async def clear(self) -> None:
        """Clear the buffer."""
        async with self._async_lock:
            self._buffer.clear()

    @property
    def size(self) -> int:
        """Get current buffer size."""
        return len(self._buffer)
