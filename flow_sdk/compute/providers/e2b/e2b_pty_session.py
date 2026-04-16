"""E2BPtySession — concrete PTY session handle for the E2B sandbox provider.

Mirrors LocalPtySession (compute/providers/desktop/local_pty_session.py).
Reuses the global PtySessionManager and PtyReplayBuffer; only the
provider reference differs.
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, AsyncIterator

from flow_sdk.builtin.faas.pty_session import Pty

if TYPE_CHECKING:
    from flow_sdk.compute.providers.desktop.pty_replay_buffer import OutputChunk, PtyReplayBuffer
    from flow_sdk.compute.providers.desktop.pty_session_manager import PtySessionManager

    from .provider import E2BComputeProvider


class E2BPtySession(Pty):
    """Concrete PTY session backed by E2BComputeProvider + shared session manager + replay buffer."""

    def __init__(
        self,
        cn_id: str,
        pn_id: str,
        shell_id: str,
        provider: "E2BComputeProvider",
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

    async def write(self, data: bytes) -> None:
        session = self._mgr.sessions.get(self._pty_key)
        cols = session.cols if session else 80
        rows = session.rows if session else 24
        await self._provider.send_pty_input(self._pn_id, self._shell_id, data, cols, rows)

    async def resize(self, cols: int, rows: int) -> None:
        session = self._mgr.sessions.get(self._pty_key)
        if session and session.cols == cols and session.rows == rows:
            return
        await self._provider.resize_pty(self._pn_id, self._shell_id, cols, rows)
        if session:
            session.cols = cols
            session.rows = rows

    async def output(self) -> AsyncIterator[bytes]:  # type: ignore[override]
        q: asyncio.Queue = asyncio.Queue()
        session = self._mgr.sessions.get(self._pty_key)
        if session is None:
            return
        session.output_queues.append(q)
        try:
            while True:
                chunk = await q.get()
                if chunk is None:
                    break
                yield chunk
        finally:
            try:
                session.output_queues.remove(q)
            except ValueError:
                pass

    def snapshot(self, since: int = 0) -> list["OutputChunk"]:
        return self._buf.get_replay(self._pty_key, since)

    async def attach(self, connection_id: str) -> None:
        await self._mgr.attach_session(self._pty_key, connection_id)

    async def detach(self, connection_id: str) -> None:
        await self._mgr.detach_session(self._pty_key, connection_id)

    @property
    def connections(self) -> frozenset:
        session = self._mgr.sessions.get(self._pty_key)
        return frozenset(session.connection_ids) if session else frozenset()

    @property
    def name(self) -> str | None:
        session = self._mgr.sessions.get(self._pty_key)
        return session.name if session else None

    @name.setter
    def name(self, value: str) -> None:
        session = self._mgr.sessions.get(self._pty_key)
        if session:
            session.name = value

    @property
    def cols(self) -> int:
        session = self._mgr.sessions.get(self._pty_key)
        return session.cols if session else 80

    @property
    def rows(self) -> int:
        session = self._mgr.sessions.get(self._pty_key)
        return session.rows if session else 24

    async def kill(self) -> None:
        self._signal_output_queues()
        self._buf.clear(self._pty_key)
        self._mgr.sessions.pop(self._pty_key, None)
        await self._provider.close_pty_session(self._pn_id, self._shell_id)

    async def close(self) -> None:
        self._signal_output_queues()
        self._buf.clear(self._pty_key)
        await self._mgr.close_session(self._pty_key)
        await self._provider.close_pty_session(self._pn_id, self._shell_id)

    async def close_for_connection(self, connection_id: str | None) -> None:
        await self._mgr.close_for_connection(self._pty_key, connection_id)
        if self._pty_key not in self._mgr.sessions:
            self._buf.clear(self._pty_key)

    @property
    def latest_seq(self) -> int:
        return self._buf.get_latest_seq(self._pty_key)

    def _signal_output_queues(self) -> None:
        session = self._mgr.sessions.get(self._pty_key)
        if not session or not session.output_queues:
            return
        loop = None
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            pass
        for q in list(session.output_queues):
            if loop and not loop.is_closed():
                asyncio.run_coroutine_threadsafe(q.put(None), loop)
