"""PTY Replay Buffer - Circular buffer for PTY output with sequence tracking.

This module provides a bounded replay buffer for each PTY session,
enabling clients to request recent output after reconnecting.
"""

import logging
import time
from collections import deque
from typing import Deque, Dict, List, Optional, Tuple

from pydantic import BaseModel, ConfigDict

logger = logging.getLogger(__name__)

# Buffer limits
MAX_BUFFER_SIZE_BYTES = 2 * 1024 * 1024  # 2MB
MAX_BUFFER_CHUNKS = 5000


class OutputChunk(BaseModel):
    """A single chunk of PTY output with sequence number."""

    seq: int  # Monotonic sequence number
    data: bytes  # Raw PTY output
    timestamp: float  # Unix timestamp when chunk was added

    model_config = ConfigDict(arbitrary_types_allowed=True)


class SessionBuffer:
    """Circular buffer for a single PTY session."""

    def __init__(self):
        """Initialize empty session buffer."""
        self.chunks: Deque[OutputChunk] = deque()
        self.total_size_bytes: int = 0
        self.next_seq: int = 1  # Start sequence at 1

    def append(self, data: bytes) -> "OutputChunk":
        """Append output chunk to buffer with sequence number.

        Args:
            data: Raw PTY output bytes

        Returns:
            The OutputChunk that was appended (contains seq and timestamp)
        """
        seq = self.next_seq
        self.next_seq += 1

        chunk = OutputChunk(seq=seq, data=data, timestamp=time.time())
        self.chunks.append(chunk)
        self.total_size_bytes += len(data)

        # Evict old chunks if limits exceeded
        while self._should_evict():
            self._evict_oldest()

        return chunk

    def _should_evict(self) -> bool:
        """Check if buffer should evict oldest chunk."""
        if len(self.chunks) <= 1:
            return False  # Never evict the last chunk

        return len(self.chunks) > MAX_BUFFER_CHUNKS or self.total_size_bytes > MAX_BUFFER_SIZE_BYTES

    def _evict_oldest(self) -> None:
        """Remove oldest chunk from buffer."""
        if not self.chunks:
            return

        oldest = self.chunks.popleft()
        self.total_size_bytes -= len(oldest.data)

    def get_replay(self, since_seq: int) -> List[OutputChunk]:
        """Get all chunks with seq > since_seq.

        Args:
            since_seq: Return chunks after this sequence number

        Returns:
            List of OutputChunk objects in order
        """
        replay = [chunk for chunk in self.chunks if chunk.seq > since_seq]
        return replay

    def get_latest_seq(self) -> int:
        """Get the most recent sequence number.

        Returns:
            Latest sequence number, or 0 if buffer is empty
        """
        if not self.chunks:
            return 0
        return self.chunks[-1].seq

    def clear(self) -> None:
        """Clear all chunks from buffer."""
        self.chunks.clear()
        self.total_size_bytes = 0


class PtyReplayBuffer:
    """Global replay buffer manager for all PTY sessions.

    Manages circular buffers for each session, with automatic cleanup
    when sessions are closed.
    """

    _instance: Optional["PtyReplayBuffer"] = None

    def __init__(self):
        """Initialize the replay buffer manager."""
        self.buffers: Dict[Tuple[str, str, str], SessionBuffer] = {}
        logger.info("[PtyReplayBuffer] Initialized")

    @classmethod
    def get_instance(cls) -> "PtyReplayBuffer":
        """Get singleton instance of PtyReplayBuffer."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Reset singleton instance (useful for testing)."""
        cls._instance = None

    def _get_or_create_buffer(self, session_key: Tuple[str, str, str]) -> SessionBuffer:
        """Get existing buffer or create new one for session.

        Args:
            session_key: (compute_node_id, provider_node_id, shell_id) tuple

        Returns:
            SessionBuffer for the session
        """
        if session_key not in self.buffers:
            self.buffers[session_key] = SessionBuffer()
            logger.info(f"[PtyReplayBuffer] Created buffer for session {session_key}")

        return self.buffers[session_key]

    def append(self, session_key: Tuple[str, str, str], data: bytes) -> "OutputChunk":
        """Append output chunk to session buffer.

        Args:
            session_key: (compute_node_id, provider_node_id, shell_id) tuple
            data: Raw PTY output bytes

        Returns:
            The OutputChunk that was appended (contains seq and timestamp)
        """
        buffer = self._get_or_create_buffer(session_key)
        chunk = buffer.append(data)

        logger.debug(
            f"PTY output chunk appended: session_key={session_key} seq={chunk.seq}"
            f" size_bytes={len(data)} buffer_chunks={len(buffer.chunks)} buffer_size_bytes={buffer.total_size_bytes}"
        )

        return chunk

    def get_replay(self, session_key: Tuple[str, str, str], since_seq: int) -> List[OutputChunk]:
        """Get replay chunks for session since given sequence.

        Args:
            session_key: (compute_node_id, provider_node_id, shell_id) tuple
            since_seq: Return chunks after this sequence number

        Returns:
            List of OutputChunk objects in order
        """
        buffer = self.buffers.get(session_key)
        if not buffer:
            logger.info(f"PTY replay buffer not found: session_key={session_key}")
            return []

        replay = buffer.get_replay(since_seq)

        logger.info(
            f"PTY replay retrieved: session_key={session_key} since_seq={since_seq}"
            f" replay_chunks={len(replay)} buffer_chunks={len(buffer.chunks)}"
        )

        return replay

    def get_latest_seq(self, session_key: Tuple[str, str, str]) -> int:
        """Get latest sequence number for session.

        Args:
            session_key: (compute_node_id, provider_node_id, shell_id) tuple

        Returns:
            Latest sequence number, or 0 if buffer doesn't exist
        """
        buffer = self.buffers.get(session_key)
        if not buffer:
            return 0

        latest = buffer.get_latest_seq()
        logger.debug(f"PTY latest seq retrieved: session_key={session_key} latest_seq={latest}")
        return latest

    def clear(self, session_key: Tuple[str, str, str]) -> None:
        """Clear and remove buffer for session.

        Args:
            session_key: (compute_node_id, provider_node_id, shell_id) tuple
        """
        buffer = self.buffers.pop(session_key, None)
        if buffer:
            buffer.clear()
            logger.info(f"PTY buffer cleared: session_key={session_key}")
            logger.info(f"[PtyReplayBuffer] Cleared buffer for session {session_key}")

    def get_buffer_stats(self) -> Dict[str, int]:
        """Get statistics about all buffers.

        Returns:
            Dictionary with stats (total_buffers, total_chunks, total_size_bytes)
        """
        total_chunks = sum(len(buf.chunks) for buf in self.buffers.values())
        total_size_bytes = sum(buf.total_size_bytes for buf in self.buffers.values())

        return {
            "total_buffers": len(self.buffers),
            "total_chunks": total_chunks,
            "total_size_bytes": total_size_bytes,
        }


# Global singleton instance
replay_buffer = PtyReplayBuffer.get_instance()
