"""PTY Session Manager - Manages persistent PTY session state.

This module provides session persistence across WebSocket reconnections,
enabling terminal refresh recovery without losing running processes.
"""

import asyncio
import logging
import time
from typing import Any, Dict, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)


class PtySessionState(BaseModel):
    """State for a persistent PTY session.

    Supports multiple concurrent client connections to the same PTY session.
    """

    pty_key: Tuple[str, str, str]  # (compute_node_id, provider_node_id, shell_id)
    connection_ids: set[str] = Field(default_factory=set)  # All attached WebSocket connections
    created_at: float = Field(default_factory=time.time)
    last_attached_at: float = Field(default_factory=time.time)
    last_detached_at: Optional[float] = None
    shell_id: Optional[str] = None
    name: Optional[str] = None  # Display name for the session
    terminal_id: Optional[str] = None
    last_seq_received: Optional[int] = None
    compute_node_id: Optional[str] = None
    cols: int = 80
    rows: int = 24
    provider_session_data: Dict[str, Any] = Field(default_factory=dict)
    pty_stream_file: Any = None
    output_queues: list = Field(default_factory=list)  # asyncio.Queue feeds for Pty.output()

    model_config = ConfigDict(arbitrary_types_allowed=True)

    @property
    def connection_id(self) -> Optional[str]:
        """Backward compatibility: return first connection or None"""
        return next(iter(self.connection_ids)) if self.connection_ids else None

    @property
    def is_attached(self) -> bool:
        """Check if any client is attached"""
        return len(self.connection_ids) > 0


class PtySessionManager:
    """Singleton manager for PTY sessions with persistence and cleanup.

    Manages PTY session lifecycle:
    - Session creation and storage
    - Attach/detach tracking
    - TTL-based cleanup for expired sessions
    """

    _instance: Optional["PtySessionManager"] = None

    def __init__(self):
        """Initialize the PTY session manager."""
        self.sessions: Dict[Tuple[str, str, str], PtySessionState] = {}
        self._cleanup_task: Optional[asyncio.Task] = None
        logger.info("[PtySessionManager] Initialized")

    @classmethod
    def get_instance(cls) -> "PtySessionManager":
        """Get singleton instance of PtySessionManager."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Reset singleton instance (useful for testing)."""
        if cls._instance and cls._instance._cleanup_task:
            cls._instance._cleanup_task.cancel()
        cls._instance = None

    async def generate_session(
        self,
        pty_key: Tuple[str, str, str],
        compute_node_id: str,
        connection_id: str | None,
        cols: int = 80,
        rows: int = 24,
    ) -> PtySessionState:
        """Get existing session or create new one.

        Args:
            pty_key: (compute_node_id, provider_node_id, shell_id) tuple
            compute_node_id: Compute node ID
            connection_id: WebSocket connection ID
            cols: Terminal columns
            rows: Terminal rows

        Returns:
            PtySessionState for the session
        """
        if pty_key in self.sessions:
            session = self.sessions[pty_key]
            session.compute_node_id = compute_node_id
            if connection_id is not None:
                session.connection_ids.add(connection_id)
            session.last_attached_at = time.time()
            session.last_detached_at = None
            session.cols = cols
            session.rows = rows
            logger.info(
                f"PTY session retrieved: pty_key={pty_key} connection_id={connection_id}"
                f" total_connections={len(session.connection_ids)} age_seconds={time.time() - session.created_at:.1f}"
            )
            return session

        # Create new session
        session = PtySessionState(
            pty_key=pty_key,
            cols=cols,
            rows=rows,
        )
        if connection_id is not None:
            session.connection_ids.add(connection_id)
        self.sessions[pty_key] = session

        logger.info(
            f"PTY session created: pty_key={pty_key} connection_id={connection_id} total_sessions={len(self.sessions)}"
        )

        return session

    async def get_session(self, pty_key: Tuple[str, str, str]) -> Optional[PtySessionState]:
        """Get existing session by key.

        Args:
            pty_key: (compute_node_id, provider_node_id, shell_id) tuple

        Returns:
            PtySessionState if found, None otherwise
        """
        session = self.sessions.get(pty_key)
        if session:
            logger.debug(f"PTY session retrieved: pty_key={pty_key}")
        else:
            logger.debug(f"PTY session not found: pty_key={pty_key}")
        return session

    async def attach_session(self, pty_key: Tuple[str, str, str], connection_id: str) -> PtySessionState:
        """Attach to existing PTY session.

        Args:
            pty_key: (compute_node_id, provider_node_id, shell_id) tuple
            connection_id: WebSocket connection ID

        Returns:
            PtySessionState for the session

        Raises:
            KeyError: If session not found
        """
        session = self.sessions.get(pty_key)
        if not session:
            logger.error(f"PTY session not found for attach: pty_key={pty_key}")
            raise KeyError(f"Session {pty_key} not found")

        session.connection_ids.add(connection_id)
        session.last_attached_at = time.time()
        if session.last_detached_at and len(session.connection_ids) == 1:
            # First client reattaching after detachment
            session.last_detached_at = None

        logger.info(
            f"PTY session reattached: pty_key={pty_key} connection_id={connection_id}"
            f" total_connections={len(session.connection_ids)}"
            f" detached_duration_seconds={time.time() - session.last_detached_at if session.last_detached_at else 0}"
        )

        return session

    async def detach_session(self, pty_key: Tuple[str, str, str], connection_id: Optional[str] = None) -> None:
        """Remove a connection from the session.

        Args:
            pty_key: (compute_node_id, provider_node_id, shell_id) tuple
            connection_id: Specific connection to detach (if None, detaches all)
        """
        session = self.sessions.get(pty_key)
        if not session:
            logger.warning(f"PTY session not found for detach: pty_key={pty_key}")
            return

        if connection_id:
            session.connection_ids.discard(connection_id)
            logger.info(f"[PtySessionManager] Detached connection {connection_id} from session {pty_key}")
        else:
            session.connection_ids.clear()
            logger.info(f"[PtySessionManager] Detached all connections from session {pty_key}")

        # Only mark as detached if no connections remain
        if len(session.connection_ids) == 0:
            session.last_detached_at = time.time()

        logger.info(f"PTY session detached: pty_key={pty_key} remaining_connections={len(session.connection_ids)}")

    async def close_for_connection(self, pty_key: Tuple[str, str, str], connection_id: str) -> None:
        """Remove a connection and only destroy the session if no connections remain.

        Args:
            pty_key: (compute_node_id, provider_node_id, shell_id) tuple
            connection_id: The connection requesting the close
        """
        session = self.sessions.get(pty_key)
        if not session:
            logger.warning(f"PTY session not found for close_for_connection: pty_key={pty_key}")
            return

        session.connection_ids.discard(connection_id)
        logger.info(
            f"[PtySessionManager] Connection {connection_id} closed on session {pty_key}, "
            f"remaining connections: {len(session.connection_ids)}"
        )

        if len(session.connection_ids) == 0:
            await self.close_session(pty_key)

    async def detach_all_for_connection(self, connection_id: str) -> None:
        """Remove connection_id from every session it belongs to.

        Used by the WebSocket disconnect handler to clean up stale connection
        references without closing any PTY processes.
        """
        for pty_key, session_state in list(self.sessions.items()):
            if connection_id in session_state.connection_ids:
                await self.detach_session(pty_key, connection_id)

    async def close_session(self, pty_key: Tuple[str, str, str]) -> None:
        """Close and remove PTY session.

        Args:
            pty_key: (compute_node_id, provider_node_id, shell_id) tuple
        """
        session = self.sessions.pop(pty_key, None)
        if not session:
            logger.warning(f"PTY session not found for close: pty_key={pty_key}")
            return

        compute_node_id, provider_node_id, shell_id = pty_key

        # Transition shell session record to CLOSED
        try:
            from flow_sdk.fs_records.shell_record import ShellRecord, ShellStatus

            record = ShellRecord.get(shell_id)
            if record:
                record.close()
        except Exception as e:
            logger.warning(f"[PtySessionManager] Error closing shell session record {shell_id}: {e}")

        # Delete PTY stream file if present
        if session.pty_stream_file:
            try:
                session.pty_stream_file.delete()
            except Exception as e:
                logger.warning(f"[PtySessionManager] Error deleting PTY stream file for {shell_id}: {e}")

        # Close PTY via provider
        try:
            from flow_sdk.builtin.faas.compute_node import ComputeNode

            # Get compute node and close PTY
            compute_node = await ComputeNode.get_by_id(compute_node_id)
            if compute_node and compute_node.node_provider_id:
                await compute_node.compute_provider.close_pty_session(compute_node.node_provider_id, shell_id)
        except Exception as e:
            logger.warning(f"[PtySessionManager] Error closing PTY {pty_key}: {e}")

        logger.info(f"PTY session closed: pty_key={pty_key} total_sessions={len(self.sessions)}")

    def is_expired(self, session: PtySessionState, ttl_seconds: int) -> bool:
        """Check if session has been detached for longer than TTL.

        Args:
            session: Session to check
            ttl_seconds: Time-to-live in seconds

        Returns:
            True if session is expired, False otherwise
        """
        if session.last_detached_at is None:
            return False  # Currently attached

        elapsed = time.time() - session.last_detached_at
        return elapsed > ttl_seconds

    async def cleanup_expired_sessions(self, ttl_seconds: int = 900) -> int:
        """Close and remove sessions that have been detached for > TTL.

        Args:
            ttl_seconds: Time-to-live in seconds (default: 15 minutes)

        Returns:
            Number of sessions cleaned up
        """
        expired_count = 0
        expired_keys = []

        for pty_key, session in self.sessions.items():
            if self.is_expired(session, ttl_seconds):
                expired_keys.append(pty_key)

        for pty_key in expired_keys:
            await self.close_session(pty_key)
            expired_count += 1

        if expired_count > 0:
            logger.info(
                f"PTY cleanup completed: expired_count={expired_count} total_sessions={len(self.sessions)} ttl_seconds={ttl_seconds}"
            )

        return expired_count

    async def start_cleanup_task(self, interval_seconds: int = 120, ttl_seconds: int = 900) -> None:
        """Start background cleanup task.

        Args:
            interval_seconds: Cleanup interval in seconds (default: 2 minutes)
            ttl_seconds: Session TTL in seconds (default: 15 minutes)
        """
        if self._cleanup_task and not self._cleanup_task.done():
            logger.warning("[PtySessionManager] Cleanup task already running")
            return

        async def cleanup_loop():
            logger.info(
                f"[PtySessionManager] Starting cleanup task (interval: {interval_seconds}s, TTL: {ttl_seconds}s)"
            )
            while True:
                try:
                    await asyncio.sleep(interval_seconds)
                    await self.cleanup_expired_sessions(ttl_seconds)
                except asyncio.CancelledError:
                    logger.info("[PtySessionManager] Cleanup task cancelled")
                    break
                except Exception as e:
                    logger.error(f"[PtySessionManager] Error in cleanup task: {e}", exc_info=True)

        self._cleanup_task = asyncio.create_task(cleanup_loop())
        logger.info("[PtySessionManager] Cleanup task started")

    async def stop_cleanup_task(self) -> None:
        """Stop background cleanup task."""
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            logger.info("[PtySessionManager] Cleanup task stopped")


# Global singleton instance
session_manager = PtySessionManager.get_instance()
