"""Turns over a print-mode worker that outlives them.

A print-mode CLI normally lives exactly one turn: the answer ends the turn and the
process exits with it. When the agent leaves background work running (a deploy
watcher, a build), ``claude -p`` instead stays alive until that work ends — and a
process that exits kills the work and the report the agent owes the user. While it
is alive but idle between turns the worker is *parked*: no turn is open, ``busy`` is
false, and a message the user sends is written to the SAME process and answered in
about a second, instead of waiting for the background work to finish.

This module is the bookkeeping that makes that one process look like what the rest
of the app expects — a series of turns, each with a start, an end and a listener:

* a turn **begins** when a message is delivered to the parked worker, or when the CLI
  starts one on its own (the report of a background command that finished);
* it **ends** when the CLI reports ``idle`` and keeps the process for its background
  work. When the process is about to exit instead, the turn is left open: the runner's
  own ``finally`` ends it, exactly as a one-turn worker always has;
* the **listener** is the HTTP response of the request that delivered the message, if
  any. A turn nobody sent (the CLI's own report) has none: the transcript carries it
  and the UI follows it through ``observe-turn``.

The CLI's frames are routed through :meth:`WorkerTurns.route`; the worker's own state
(``parked``, ``session_state``) decides every edge, never a count of turns.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

logger = logging.getLogger(__name__)

#: The CLI's typed report of what it is doing; consumed here, never shown in the chat.
SESSION_STATE_SUBTYPE = "session_state_changed"


class TurnSink(Protocol):
    """Whatever carries a turn's frames to the request that sent it (an SSE handler)."""

    async def on_flow_data(self, flow_data: "FlowData | None") -> None: ...


_WORKER_TURNS: dict[str, "WorkerTurns"] = {}


def worker_turns_for(process_id: str) -> "WorkerTurns | None":
    """The turns bookkeeping of ``process_id``'s live print-mode worker, if it has one."""
    return _WORKER_TURNS.get(process_id)


class WorkerTurns:
    """One worker's turns: which is open, who listens, and what each edge does to ``busy``."""

    def __init__(
        self,
        process: "AgenticProcess",
        worker: Any,
        *,
        log_prefix: str,
        lock: asyncio.Lock | None = None,
    ) -> None:
        self.process = process
        self.worker = worker
        self.log_prefix = log_prefix
        #: The per-process prompt lock, for the runner that holds it for a turn's duration.
        self.lock = lock
        self._holds_lock = False
        #: True while a turn is open — ``busy``'s own flag, ahead of the CLI's report.
        self.open = False
        #: The listener of the open turn, or None (a turn nobody sent, or no turn).
        self.sink: TurnSink | None = None

    # ── registry ──────────────────────────────────────────────────────────────

    def register(self) -> None:
        _WORKER_TURNS[self.process.id] = self

    def discard(self) -> None:
        if _WORKER_TURNS.get(self.process.id) is self:
            del _WORKER_TURNS[self.process.id]

    # ── edges ─────────────────────────────────────────────────────────────────

    async def begin(self, sink: TurnSink | None = None, *, announce: bool = True) -> None:
        """A turn starts: ``busy`` goes on and, if one is waiting, the listener attaches."""
        if sink is not None:
            # A listener still attached belongs to the turn this one follows (its ``idle`` has
            # not been routed yet): that turn is over, so its stream ends instead of hanging.
            if self.sink is not None and self.sink is not sink:
                await self._close_sink()
            self.sink = sink
        if self.open:
            return
        self.open = True
        if self.lock is not None and not self._holds_lock:
            await self.lock.acquire()
            self._holds_lock = True
        object.__setattr__(self.process, "_turn_in_flight", True)
        if announce:
            try:
                await self.process.notify_updated()
            except Exception:
                logger.exception("%s: start-of-turn notify_updated failed", self.log_prefix)

    async def end(self) -> None:
        """The turn is over and the process stays: close its listener, release the slot, run the tail."""
        if not self.open:
            return
        self.open = False
        await self._close_sink()
        self.release_lock()
        await self.process.end_headless_turn(self.log_prefix)

    def release_lock(self) -> None:
        if self.lock is not None and self._holds_lock:
            self._holds_lock = False
            self.lock.release()

    async def _close_sink(self) -> None:
        sink, self.sink = self.sink, None
        if sink is not None:
            await sink.on_flow_data(None)

    async def close(self) -> None:
        """The worker is gone: end whatever stream is still attached. Idempotent."""
        await self._close_sink()

    # ── frames ────────────────────────────────────────────────────────────────

    async def route(self, fd: "FlowData") -> "FlowData | None":
        """Apply a frame's turn-boundary meaning; return the frame to forward, or None.

        The CLI's state frames are control, not content, so they are consumed here. The
        edge is read from the worker's CURRENT state, not from the frame: a state frame
        can be handled a moment after the CLI wrote it, by which time a delivered
        message may already have started the next turn — and that turn must not be
        ended by the previous turn's ``idle``.
        """
        if fd.attributes.get("subtype") != SESSION_STATE_SUBTYPE:
            return fd
        state = self.worker.session_state
        if state == "idle":
            # Parked → the process stays: this turn ends here. Not parked → the process is
            # exiting, and the runner's ``finally`` ends the turn as it always has.
            if self.open and self.worker.parked:
                await self.end()
        elif state is not None and not self.open:
            # The CLI began a turn on its own: the report of background work that just ended.
            await self.begin()
        return None

    async def deliver(self, text: str, sink: TurnSink | None = None) -> bool:
        """Write ``text`` to the parked worker as a new turn. False when it was not parked.

        ``busy`` goes on BEFORE the bytes leave, so nothing can read "idle" between the
        message and the CLI's own ``running``. The claim is one synchronous step (see
        ``claim_for_message``): of two requests racing to deliver, exactly one wins.
        """
        if not self.worker.claim_for_message():
            return False
        await self.begin(sink)
        if await self.worker.write_user_message(text):
            return True
        # The process went away between the claim and the write: undo, so the caller can
        # start a fresh worker for this message instead of losing it.
        self.sink = None
        await self.end()
        return False
