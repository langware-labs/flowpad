"""Pty — abstract interface for PTY session handles.

Returned by ComputeNode.get_pty() and ComputeNode.create_pty().
Concrete implementation: LocalPtySession (in compute/providers/local/).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import AsyncIterator


class Pty(ABC):
    """Abstract handle to a live PTY session.

    Callers:
    - shell.compute_node.get_pty(shell.id)    → Pty | None
    - shell.compute_node.create_pty(shell.id) → Pty

    Main API:
    - pty.is_alive              — sync, fast
    - await pty.write(data)     — write bytes to PTY stdin
    - await pty.resize(c, r)    — resize terminal
    - pty.output()              — AsyncIterator streaming live PTY output
    - pty.snapshot(since)       — get buffered output chunks (reconnect recovery)
    - pty.latest_seq            — current replay buffer head
    - await pty.attach(id)      — add WebSocket connection
    - await pty.detach(id)      — remove WebSocket connection
    - pty.connections           — frozenset of attached WebSocket connection IDs
    - pty.name / pty.name = ..  — display label (r/w property)
    - pty.cols / pty.rows       — terminal dimensions
    - await pty.close()         — permanent teardown (kill + delete disk record)
    - await pty.kill()          — crash simulation (evicts state, kills OS process)
    - await pty.close_for_connection(id) — detach; destroy only if last connection
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
    async def write(self, data: bytes) -> None:
        """Write bytes to PTY stdin."""

    @abstractmethod
    async def resize(self, cols: int, rows: int) -> None:
        """Resize the PTY terminal.

        No-op if dimensions are unchanged — avoids spurious SIGWINCH which
        causes zsh to redraw and produce artifacts on reconnect.
        """

    @abstractmethod
    def output(self) -> AsyncIterator[bytes]:
        """Stream live PTY output as it arrives.

        Each yielded value is one OS read chunk (raw bytes).
        Iteration ends when the PTY is closed or killed.
        """

    @abstractmethod
    def snapshot(self, since: int = 0) -> list:
        """Get output chunks with seq > since.

        Use on reconnect: store latest_seq before disconnect, pass on return.
        Buffer bounds: 2 MB / 5000 chunks. Oldest chunks evicted first.
        """

    @property
    @abstractmethod
    def latest_seq(self) -> int:
        """Current maximum sequence number in the replay buffer. 0 if no output yet."""

    @abstractmethod
    async def attach(self, connection_id: str) -> None:
        """Route live PTY output to this WebSocket connection."""

    @abstractmethod
    async def detach(self, connection_id: str) -> None:
        """Stop routing output to this connection. PTY keeps running."""

    @property
    @abstractmethod
    def connections(self) -> frozenset:
        """Currently attached WebSocket connection IDs."""

    @property
    @abstractmethod
    def name(self) -> str | None:
        """Display label shown in the UI tab strip."""

    @name.setter
    @abstractmethod
    def name(self, value: str) -> None:
        """Set display label."""

    @property
    @abstractmethod
    def cols(self) -> int:
        """Current terminal width. Updated by resize()."""

    @property
    @abstractmethod
    def rows(self) -> int:
        """Current terminal height. Updated by resize()."""

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

