"""LocalPtySession — concrete PTY session handle for the local machine provider.

Internal to the local/ package. Never imported outside compute/providers/local/.
Returned by LocalComputeProvider.get_pty_session() as a PtySession.
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from flow_sdk.builtin.faas.pty_session import PtySession

if TYPE_CHECKING:
    from .provider import LocalComputeProvider
    from .pty_replay_buffer import OutputChunk, PtyReplayBuffer
    from .pty_session_manager import PtySessionManager


class LocalPtySession(PtySession):
    """Concrete PTY session backed by LocalComputeProvider + PtySessionManager + PtyReplayBuffer."""

    def __init__(
        self,
        cn_id: str,
        pn_id: str,
        shell_id: str,
        provider: "LocalComputeProvider",
        mgr: "PtySessionManager",
        buf: "PtyReplayBuffer",
    ) -> None:
        self._cn_id = cn_id
        self._pn_id = pn_id
        self._shell_id = shell_id
        self._provider = provider
        self._mgr = mgr
        self._buf = buf

    @property
    def _pty_key(self) -> tuple:
        return (self._cn_id, self._pn_id, self._shell_id)

    @property
    def shell_id(self) -> str:
        return self._shell_id

    @property
    def is_alive(self) -> bool:
        return self._provider.is_pty_alive(self._pn_id, self._shell_id)

    async def send(self, data: bytes) -> None:
        session = self._mgr.sessions.get(self._pty_key)
        cols = session.cols if session else 80
        rows = session.rows if session else 24
        await self._provider.send_pty_input(self._pn_id, self._shell_id, data, cols, rows)

    async def resize(self, cols: int, rows: int) -> None:
        # Skip if unchanged — avoids unnecessary SIGWINCH which causes zsh to
        # redraw and produce duplicate content / '%' artifacts on reattach.
        session = self._mgr.sessions.get(self._pty_key)
        if session and session.cols == cols and session.rows == rows:
            return
        await self._provider.resize_pty(self._pn_id, self._shell_id, cols, rows)
        if session:
            session.cols = cols
            session.rows = rows

    async def attach(self, connection_id: str) -> None:
        await self._mgr.attach_session(self._pty_key, connection_id)

    async def detach(self, connection_id: str) -> None:
        await self._mgr.detach_session(self._pty_key, connection_id)

    def get_replay(self, since_seq: int = 0) -> list["OutputChunk"]:
        return self._buf.get_replay(self._pty_key, since_seq)

    async def kill(self) -> None:
        """Crash simulation: kill OS PTY and evict in-memory state.

        Does NOT touch the DB or .pty stream file — identical to what
        happens after a real server SIGKILL.
        """
        self._buf.clear(self._pty_key)
        self._mgr.sessions.pop(self._pty_key, None)
        await self._provider.close_pty_session(self._pn_id, self._shell_id)

    async def close(self) -> None:
        """Permanent teardown: kill OS PTY, close disk record, clear in-memory state."""
        self._buf.clear(self._pty_key)
        await self._mgr.close_session(self._pty_key)
        await self._provider.close_pty_session(self._pn_id, self._shell_id)

    async def close_for_connection(self, connection_id: str | None) -> None:
        """Detach connection; destroy session only if no connections remain."""
        await self._mgr.close_for_connection(self._pty_key, connection_id)
        if self._pty_key not in self._mgr.sessions:
            self._buf.clear(self._pty_key)

    def set_name(self, name: str) -> None:
        """Set display name of this session."""
        session = self._mgr.sessions.get(self._pty_key)
        if session:
            session.name = name

    @property
    def latest_seq(self) -> int:
        """Current maximum sequence number in the replay buffer."""
        return self._buf.get_latest_seq(self._pty_key)
