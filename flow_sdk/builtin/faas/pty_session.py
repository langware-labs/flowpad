"""PtySession — abstract interface for PTY session handles.

Returned by ComputeNode.get_pty() and ComputeNode.create_pty().
Concrete implementation: LocalPtySession (in compute/providers/local/).
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class PtySession(ABC):
    """Abstract handle to a live PTY session.

    Callers:
    - shell.compute_node.get_pty(shell.id)    → PtySession | None
    - shell.compute_node.create_pty(shell.id) → PtySession

    Operations:
    - pty.is_alive              — sync, fast
    - await pty.send(data)      — write bytes to PTY stdin
    - await pty.resize(c, r)    — resize terminal
    - await pty.attach(id)      — add WebSocket connection
    - await pty.detach(id)      — remove WebSocket connection
    - pty.get_replay(since_seq) — get buffered output chunks
    - await pty.kill()          — crash simulation (evicts state, kills OS process)
    - await pty.close()         — permanent teardown (kill + delete disk record)
    """

    @property
    @abstractmethod
    def shell_id(self) -> str:
        """Shell ID for this session."""

    @property
    @abstractmethod
    def is_alive(self) -> bool:
        """Whether the PTY process is still running."""

    @abstractmethod
    async def send(self, data: bytes) -> None:
        """Write bytes to PTY stdin."""

    @abstractmethod
    async def resize(self, cols: int, rows: int) -> None:
        """Resize the PTY terminal."""

    @abstractmethod
    async def attach(self, connection_id: str) -> None:
        """Add a WebSocket connection to receive PTY output."""

    @abstractmethod
    async def detach(self, connection_id: str) -> None:
        """Remove a WebSocket connection."""

    @abstractmethod
    def get_replay(self, since_seq: int = 0) -> list:
        """Get output chunks since the given sequence number."""

    @abstractmethod
    async def kill(self) -> None:
        """Crash simulation: kill OS PTY and evict in-memory state.

        Does NOT touch the DB or .pty stream file.
        """

    @abstractmethod
    async def close(self) -> None:
        """Permanent teardown: kill OS PTY, close disk record, clear in-memory state."""

    @abstractmethod
    async def close_for_connection(self, connection_id: str | None) -> None:
        """Detach connection; destroy session only if no connections remain."""

    @abstractmethod
    def set_name(self, name: str) -> None:
        """Set display name of this session."""

    @property
    @abstractmethod
    def latest_seq(self) -> int:
        """Current maximum sequence number in the replay buffer."""
