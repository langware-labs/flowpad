"""BasePtySession — shared Pty handle body used by every provider.

LocalPtySession and E2BPtySession wrap the shared
PtyRegistry in the exact same way; only the provider type attribute
differs. This module holds the shared body; the per-provider subclasses are
trivial type-annotation shells.
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, AsyncIterator

from flow_sdk.builtin.faas.pty_session import Pty

if TYPE_CHECKING:
    from flow_sdk.compute.providers.compute_provider import ComputeProvider
    from flow_sdk.compute.providers.desktop.pty_session_manager import PtyKey, PtyRegistry

# Gap between the two winsize calls in force_repaint(). The target must OBSERVE
# the intermediate (rows-1) size before it is restored: SIGWINCH is handled
# asynchronously, and an instant toggle gets coalesced — zsh's ZLE sees "no
# change" and never redraws (verified empirically; vi/claude/codex redraw
# either way). 50ms gives the process a scheduling quantum to read the smaller
# winsize. User-approved (2026-06-05) — this is the jiggle protocol, not a race
# band-aid.
_FORCE_REPAINT_JIGGLE_S = 0.05


class PtySession(Pty):
    """Pty handle backed by any ComputeProvider + shared session manager."""

    def __init__(
        self,
        cn_id: str,
        pn_id: str,
        shell_id: str,
        provider: "ComputeProvider",
        mgr: "PtyRegistry",
    ) -> None:
        self._cn_id = cn_id
        self._pn_id = pn_id
        self._shell_id = shell_id
        self._provider = provider
        self._mgr = mgr

    @property
    def _pty_key(self) -> "PtyKey":
        return (self._cn_id, self._pn_id, self._shell_id)

    @property
    def shell_id(self) -> str:
        return self._shell_id

    @property
    def is_alive(self) -> bool:
        return self._provider.is_pty_alive(self._pn_id, self._shell_id)

    async def write(self, data: bytes) -> None:
        """Write bytes to PTY stdin."""
        session = self._mgr.states.get(self._pty_key)
        cols = session.cols if session else 80
        rows = session.rows if session else 24
        await self._provider.send_pty_input(self._pn_id, self._shell_id, data, cols, rows)

    async def resize(self, cols: int, rows: int) -> None:
        # Skip if unchanged — avoids unnecessary SIGWINCH which causes zsh to
        # redraw and produce duplicate content / '%' artifacts on reattach.
        session = self._mgr.states.get(self._pty_key)
        if session and session.cols == cols and session.rows == rows:
            return
        await self._provider.resize_pty(self._pn_id, self._shell_id, cols, rows)
        if session:
            session.cols = cols
            session.rows = rows
        self._record_resize(session, cols, rows)

    async def force_repaint(self) -> None:
        """Force a TUI repaint by toggling the winsize (SIGWINCH) with no net
        size change.

        Attach-only: a freshly attached client has a blank terminal and needs
        the running program (claude/vim/readline) to redraw its live frame.
        Deliberately bypasses resize()'s same-size skip by calling the
        provider directly, and restores the exact current size so the next
        real resize() still no-ops correctly.
        """
        session = self._mgr.states.get(self._pty_key)
        if session is None:
            return
        cols, rows = session.cols, session.rows
        # Both jiggle flips are recorded as resize frames: output the TUI
        # emits between them is calibrated to (rows-1), and replay must
        # interpret it at that size or cursor-relative repaints garble.
        await self._provider.resize_pty(self._pn_id, self._shell_id, cols, max(1, rows - 1))
        self._record_resize(session, cols, max(1, rows - 1))
        await asyncio.sleep(_FORCE_REPAINT_JIGGLE_S)  # see constant for rationale
        await self._provider.resize_pty(self._pn_id, self._shell_id, cols, rows)
        self._record_resize(session, cols, rows)

    @staticmethod
    def _record_resize(session, cols: int, rows: int) -> None:
        """Append a resize frame to the session's stream file (best-effort)."""
        stream = getattr(session, "pty_stream_file", None) if session else None
        if stream is None:
            return
        try:
            stream.write_resize(cols, rows)
        except OSError:
            pass  # persistence is best-effort; never break the resize path

    async def repaint(self, cols: int | None = None, rows: int | None = None) -> None:
        """Make the running program redraw for an attaching client.

        Asserts the client's terminal size when given and different (a real
        resize delivers SIGWINCH); otherwise jiggles the winsize at the current
        size. This is the attach-time size policy — callers pass the client's
        xterm dims (or None to keep the current size and just repaint).
        """
        if cols is not None and rows is not None and (cols != self.cols or rows != self.rows):
            await self.resize(cols, rows)
        else:
            await self.force_repaint()

    async def output(self) -> AsyncIterator[bytes]:  # type: ignore[override]
        """Stream live PTY output as it arrives.

        Creates an asyncio.Queue registered on the session state. The
        on_pty_output callback (pty_actions.py) feeds the queue from the
        OS read thread via asyncio.run_coroutine_threadsafe. Iteration
        ends when a None sentinel is enqueued (on close/kill).
        """
        q: asyncio.Queue = asyncio.Queue()
        session = self._mgr.states.get(self._pty_key)
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

    async def attach(self, connection_id: str) -> None:
        await self._mgr.attach(self._pty_key, connection_id)

    async def detach(self, connection_id: str) -> None:
        await self._mgr.detach(self._pty_key, connection_id)

    @property
    def connections(self) -> frozenset:
        """Currently attached WebSocket connection IDs."""
        session = self._mgr.states.get(self._pty_key)
        return frozenset(session.attached_connections) if session else frozenset()

    @property
    def name(self) -> str | None:
        """Display label shown in the UI tab strip."""
        session = self._mgr.states.get(self._pty_key)
        return session.name if session else None

    @name.setter
    def name(self, value: str) -> None:
        session = self._mgr.states.get(self._pty_key)
        if session:
            session.name = value

    @property
    def cols(self) -> int:
        """Current terminal width."""
        session = self._mgr.states.get(self._pty_key)
        return session.cols if session else 80

    @property
    def rows(self) -> int:
        """Current terminal height."""
        session = self._mgr.states.get(self._pty_key)
        return session.rows if session else 24

    async def kill(self) -> None:
        """Crash simulation: kill OS PTY and evict in-memory state.

        Does NOT touch the DB or .pty stream file — identical to what
        happens after a real server SIGKILL.
        """
        self._signal_output_queues()
        self._mgr.states.pop(self._pty_key, None)
        await self._provider.close_pty_session(self._pn_id, self._shell_id)

    async def close(self) -> None:
        """Permanent teardown: kill OS PTY, close disk record, clear in-memory state."""
        self._signal_output_queues()
        await self._mgr.close_session(self._pty_key)
        await self._provider.close_pty_session(self._pn_id, self._shell_id)

    async def close_for_connection(self, connection_id: str | None) -> None:
        """Detach connection; destroy session only if no connections remain."""
        await self._mgr.close_for_connection(self._pty_key, connection_id)

    @property
    def latest_seq(self) -> int:
        """Monotonic per-session output counter (0 if no output yet)."""
        session = self._mgr.states.get(self._pty_key)
        return session.seq if session else 0

    def _signal_output_queues(self) -> None:
        """Send None sentinel to all output() iterators to stop them."""
        session = self._mgr.states.get(self._pty_key)
        if not session or not (session.output_queues or session.sequenced_output_queues):
            return
        loop = None
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            pass
        for q in list(session.output_queues) + list(session.sequenced_output_queues):
            if loop and not loop.is_closed():
                asyncio.run_coroutine_threadsafe(q.put(None), loop)
