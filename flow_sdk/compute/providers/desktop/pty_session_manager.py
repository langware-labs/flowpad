"""PtyRegistry — the backend-owned connection-membership FSM for PTYs.

One ``PtyState`` per running PTY (keyed by ``PtyKey``) holds its output ``seq``,
its stream file, and — the membership state — which WebSocket connections are
ATTACHED (receive live output) vs DETACHED (parked, WS dropped). The PTY process
is decoupled from any connection, so a dropped socket never kills the shell.

The FSM is driven entirely by the WS lifecycle (see server/routes/websocket.py):
  - ``on_ws_connect``    : DETACHED → ATTACHED  (resume; reconnect of same id)
  - ``on_ws_disconnect`` : ATTACHED → DETACHED  (park; transport drop, kept)
  - ``attach`` / ``generate_session`` : NONE → ATTACHED  (client opens a terminal)
  - ``close_for_connection`` : explicit close — destroys the PtyState if last
Output fan-out (pty_actions.on_pty_output) delivers to ``attached_connections``
only. The frontend declares intent once on open and otherwise just renders.

Two bounded reapers prevent leaks (``cleanup_expired_sessions``): a PtyState with
no attached connections for > TTL is closed; a parked connection that does not
reconnect within a grace is dropped from ``detached_connections``.
"""

import asyncio
import logging
import time
from typing import Any, Dict, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

# Identity of one PtyState in the registry: (compute_node_id, provider_node_id, shell_id).
# This is the registry's 3-tuple key — distinct from the provider's own 2-tuple
# (provider_node_id, session_id) used inside compute providers.
PtyKey = Tuple[str, str, str]


class PtyState(BaseModel):
    """Persistent server-side state for one PTY: its identity, output seq, and
    the set of WebSocket connections currently attached (subscribed to output).

    Survives client reconnects — the PTY process is decoupled from any single
    connection, so a dropped socket never kills the shell.
    """

    pty_key: PtyKey  # (compute_node_id, provider_node_id, shell_id)
    # Connection-membership FSM. A connection is in exactly one state per PtyState:
    #   ATTACHED  → in attached_connections, receives live output
    #   DETACHED  → in detached_connections, parked (WS dropped) — auto-restored on
    #               reconnect of the same connection_id; reaped after a grace
    #   NONE      → in neither (never subscribed, or explicitly closed)
    attached_connections: set[str] = Field(default_factory=set)
    detached_connections: dict[str, float] = Field(default_factory=dict)  # connection_id -> detached_at
    created_at: float = Field(default_factory=time.time)
    last_attached_at: float = Field(default_factory=time.time)
    last_detached_at: Optional[float] = None
    shell_id: Optional[str] = None
    name: Optional[str] = None  # Display name for the session
    terminal_id: Optional[str] = None
    last_seq_received: Optional[int] = None
    seq: int = 0  # Monotonic output-chunk counter (activity signal; no data stored)
    # Persisted stream seq at the start of this OS PTY generation. Composer
    # readiness scans only frames after this boundary so a pre-restart banner
    # or trust screen cannot authorize input into the new process.
    generation_start_seq: int = 0
    compute_node_id: Optional[str] = None
    cols: int = 80
    rows: int = 24
    provider_session_data: Dict[str, Any] = Field(default_factory=dict)
    pty_stream_file: Any = None
    output_queues: list = Field(default_factory=list)  # asyncio.Queue feeds for Pty.output()
    # Composer-readiness subscribers need the persisted output sequence beside
    # each chunk so their subscribe-then-snapshot handoff can discard overlap.
    sequenced_output_queues: list = Field(default_factory=list)

    model_config = ConfigDict(arbitrary_types_allowed=True)

    def next_seq(self) -> int:
        """Advance and return the monotonic output-chunk counter."""
        self.seq += 1
        return self.seq

    def mark_attached(self, connection_id: str) -> None:
        """The single membership-add invariant: a connection becomes ATTACHED.

        Joins the output set, drops any parked (DETACHED) entry, refreshes
        activity, and disarms the orphan TTL (there is now a live viewer).
        """
        self.attached_connections.add(connection_id)
        self.detached_connections.pop(connection_id, None)
        self.last_attached_at = time.time()
        self.last_detached_at = None

    @property
    def connection_id(self) -> Optional[str]:
        """Backward compatibility: return first connection or None"""
        return next(iter(self.attached_connections)) if self.attached_connections else None

    @property
    def is_attached(self) -> bool:
        """Check if any client is attached"""
        return len(self.attached_connections) > 0


class PtyRegistry:
    """Singleton manager for PTY sessions with persistence and cleanup.

    Manages PTY session lifecycle:
    - Session creation and storage
    - Attach/detach tracking
    - TTL-based cleanup for expired sessions
    """

    _instance: Optional["PtyRegistry"] = None

    def __init__(self):
        """Initialize the PTY session manager."""
        self.states: Dict[PtyKey, PtyState] = {}
        self._cleanup_task: Optional[asyncio.Task] = None
        logger.info("[PtyRegistry] Initialized")

    @classmethod
    def get_instance(cls) -> "PtyRegistry":
        """Get singleton instance of PtyRegistry."""
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
        pty_key: PtyKey,
        compute_node_id: str,
        connection_id: str | None,
        cols: int = 80,
        rows: int = 24,
    ) -> PtyState:
        """Get existing session or create new one.

        Args:
            pty_key: (compute_node_id, provider_node_id, shell_id) tuple
            compute_node_id: Compute node ID
            connection_id: WebSocket connection ID
            cols: Terminal columns
            rows: Terminal rows

        Returns:
            PtyState for the session
        """
        if pty_key in self.states:
            session = self.states[pty_key]
            session.compute_node_id = compute_node_id
            if connection_id is not None:
                session.attached_connections.add(connection_id)
                session.detached_connections.pop(connection_id, None)
            session.last_attached_at = time.time()
            session.last_detached_at = None
            session.cols = cols
            session.rows = rows
            logger.info(
                f"PTY session retrieved: pty_key={pty_key} connection_id={connection_id}"
                f" total_connections={len(session.attached_connections)} age_seconds={time.time() - session.created_at:.1f}"
            )
            return session

        # Create new session
        session = PtyState(
            pty_key=pty_key,
            cols=cols,
            rows=rows,
        )
        if connection_id is not None:
            session.attached_connections.add(connection_id)
        self.states[pty_key] = session

        logger.info(
            f"PTY session created: pty_key={pty_key} connection_id={connection_id} total_sessions={len(self.states)}"
        )

        return session

    async def get_session(self, pty_key: PtyKey) -> Optional[PtyState]:
        """Get existing session by key.

        Args:
            pty_key: (compute_node_id, provider_node_id, shell_id) tuple

        Returns:
            PtyState if found, None otherwise
        """
        session = self.states.get(pty_key)
        if session:
            logger.debug(f"PTY session retrieved: pty_key={pty_key}")
        else:
            logger.debug(f"PTY session not found: pty_key={pty_key}")
        return session

    async def attach(self, pty_key: PtyKey, connection_id: str) -> PtyState:
        """Attach to existing PTY session.

        Args:
            pty_key: (compute_node_id, provider_node_id, shell_id) tuple
            connection_id: WebSocket connection ID

        Returns:
            PtyState for the session

        Raises:
            KeyError: If session not found
        """
        session = self.states.get(pty_key)
        if not session:
            logger.error(f"PTY session not found for attach: pty_key={pty_key}")
            raise KeyError(f"Session {pty_key} not found")

        session.mark_attached(connection_id)
        logger.info(
            f"PTY session reattached: pty_key={pty_key} connection_id={connection_id}"
            f" total_connections={len(session.attached_connections)}"
        )
        return session

    async def detach(self, pty_key: PtyKey, connection_id: Optional[str] = None) -> None:
        """Remove a connection from the session.

        Args:
            pty_key: (compute_node_id, provider_node_id, shell_id) tuple
            connection_id: Specific connection to detach (if None, detaches all)
        """
        session = self.states.get(pty_key)
        if not session:
            logger.warning(f"PTY session not found for detach: pty_key={pty_key}")
            return

        if connection_id:
            session.attached_connections.discard(connection_id)
            logger.info(f"[PtyRegistry] Detached connection {connection_id} from session {pty_key}")
        else:
            session.attached_connections.clear()
            logger.info(f"[PtyRegistry] Detached all connections from session {pty_key}")

        # Only mark as detached if no connections remain
        if len(session.attached_connections) == 0:
            session.last_detached_at = time.time()

        logger.info(
            f"PTY session detached: pty_key={pty_key} remaining_connections={len(session.attached_connections)}"
        )

    async def close_for_connection(self, pty_key: PtyKey, connection_id: str) -> None:
        """Remove a connection and only destroy the session if no connections remain.

        Args:
            pty_key: (compute_node_id, provider_node_id, shell_id) tuple
            connection_id: The connection requesting the close
        """
        session = self.states.get(pty_key)
        if not session:
            logger.warning(f"PTY session not found for close_for_connection: pty_key={pty_key}")
            return

        session.attached_connections.discard(connection_id)
        logger.info(
            f"[PtyRegistry] Connection {connection_id} closed on session {pty_key}, "
            f"remaining connections: {len(session.attached_connections)}"
        )

        if len(session.attached_connections) == 0:
            await self.close_session(pty_key)

    async def on_ws_disconnect(self, connection_id: str, reason: str = "unknown") -> None:
        """WS-lifecycle transition: PARK this connection on every PtyState.

        Called from the WebSocket disconnect handler. Moves the connection from
        ATTACHED → DETACHED (it stops receiving output) but KEEPS the
        subscription, so a reconnect of the same connection_id auto-restores
        delivery via ``on_ws_connect``. The PTY process is never touched.

        ``reason`` names how the transport ended (clean close frame vs abort,
        FLOWPAD-1935) so a long park in a field log carries its own cause.
        """
        now = time.time()
        for pty_key, state in list(self.states.items()):
            if connection_id in state.attached_connections:
                state.attached_connections.discard(connection_id)
                state.detached_connections[connection_id] = now
                if len(state.attached_connections) == 0:
                    state.last_detached_at = now  # arms the orphan TTL
                logger.info(
                    f"[PtyRegistry] Parked connection {connection_id} on {pty_key} "
                    f"(attached={len(state.attached_connections)} detached={len(state.detached_connections)} "
                    f"reason={reason})"
                )

    async def on_ws_connect(self, connection_id: str) -> None:
        """WS-lifecycle transition: RESUME this connection on every PtyState.

        Called from the WebSocket accept handler. Moves the connection from
        DETACHED → ATTACHED on any PtyState it had a parked subscription for, so
        live output resumes with no client action. Idempotent and safe for a
        brand-new connection (no parked entries → no-op).
        """
        for pty_key, state in list(self.states.items()):
            if connection_id in state.detached_connections:
                state.mark_attached(connection_id)
                logger.info(
                    f"[PtyRegistry] Resumed connection {connection_id} on {pty_key} "
                    f"(attached={len(state.attached_connections)})"
                )

    async def close_session(self, pty_key: PtyKey) -> None:
        """Close and remove PTY session.

        Args:
            pty_key: (compute_node_id, provider_node_id, shell_id) tuple
        """
        session = self.states.pop(pty_key, None)
        if not session:
            logger.warning(f"PTY session not found for close: pty_key={pty_key}")
            return

        compute_node_id, provider_node_id, shell_id = pty_key

        # Transition shell session record to CLOSED
        try:
            from flow_sdk.builtin.shell import close_shell_record, get_shell_record

            record = get_shell_record(shell_id)
            if record:
                close_shell_record(record)
        except Exception as e:
            logger.warning(f"[PtyRegistry] Error closing shell session record {shell_id}: {e}")

        # Delete PTY stream file if present
        if session.pty_stream_file:
            try:
                session.pty_stream_file.delete()
            except Exception as e:
                logger.warning(f"[PtyRegistry] Error deleting PTY stream file for {shell_id}: {e}")

        # Close PTY via provider
        try:
            from flow_sdk.builtin.faas.compute_node import ComputeNode

            # Get compute node and close PTY
            compute_node = await ComputeNode.get_by_id(compute_node_id)
            if compute_node and compute_node.node_provider_id:
                await compute_node.compute_provider.close_pty_session(compute_node.node_provider_id, shell_id)
        except Exception as e:
            logger.warning(f"[PtyRegistry] Error closing PTY {pty_key}: {e}")

        logger.info(f"PTY session closed: pty_key={pty_key} total_sessions={len(self.states)}")

    def is_expired(self, session: PtyState, ttl_seconds: int) -> bool:
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

    async def cleanup_expired_sessions(self, ttl_seconds: int = 900, detach_grace_seconds: int = 900) -> int:
        """Close orphaned PtyStates and reap stale parked subscriptions.

        Two bounded, explicit reapers:
          1. Orphan TTL — a PtyState with no ATTACHED connections for > ttl_seconds
             is closed (PTY killed). ``last_detached_at`` arms this when the last
             connection parks or detaches.
          2. Detach grace — a DETACHED connection that hasn't reconnected within
             detach_grace_seconds is dropped from ``detached_connections`` (its
             page/socket is gone for good), so long-lived PtyStates can't
             accumulate stale parked ids.

        Args:
            ttl_seconds: Orphan TTL in seconds (default: 15 minutes)
            detach_grace_seconds: How long a parked subscription survives without
                reconnecting (default: 15 minutes)

        Returns:
            Number of sessions closed
        """
        expired_count = 0
        expired_keys = []

        now = time.time()
        for pty_key, session in self.states.items():
            if self.is_expired(session, ttl_seconds):
                expired_keys.append(pty_key)
                continue
            # Reap stale parked subscriptions on still-live PtyStates.
            stale = [cid for cid, since in session.detached_connections.items() if now - since > detach_grace_seconds]
            for cid in stale:
                session.detached_connections.pop(cid, None)
                logger.info(f"[PtyRegistry] Reaped stale parked connection {cid} from {pty_key}")

        for pty_key in expired_keys:
            await self.close_session(pty_key)
            expired_count += 1

        if expired_count > 0:
            logger.info(
                f"PTY cleanup completed: expired_count={expired_count} total_sessions={len(self.states)} ttl_seconds={ttl_seconds}"
            )

        return expired_count

    async def start_cleanup_task(self, interval_seconds: int = 120, ttl_seconds: int = 900) -> None:
        """Start background cleanup task.

        Args:
            interval_seconds: Cleanup interval in seconds (default: 2 minutes)
            ttl_seconds: Session TTL in seconds (default: 15 minutes)
        """
        if self._cleanup_task and not self._cleanup_task.done():
            logger.warning("[PtyRegistry] Cleanup task already running")
            return

        async def cleanup_loop():
            logger.info(f"[PtyRegistry] Starting cleanup task (interval: {interval_seconds}s, TTL: {ttl_seconds}s)")
            while True:
                try:
                    await asyncio.sleep(interval_seconds)
                    await self.cleanup_expired_sessions(ttl_seconds)
                except asyncio.CancelledError:
                    logger.info("[PtyRegistry] Cleanup task cancelled")
                    break
                except Exception as e:
                    logger.error(f"[PtyRegistry] Error in cleanup task: {e}", exc_info=True)

        self._cleanup_task = asyncio.create_task(cleanup_loop())
        logger.info("[PtyRegistry] Cleanup task started")

    async def stop_cleanup_task(self) -> None:
        """Stop background cleanup task."""
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            logger.info("[PtyRegistry] Cleanup task stopped")


# Global singleton instance
pty_registry = PtyRegistry.get_instance()
