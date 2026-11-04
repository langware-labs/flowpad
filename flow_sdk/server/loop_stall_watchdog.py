"""Name what froze the backend's event loop (toplog tag ``loop_stall``).

The backend is one asyncio loop: one blocking call freezes every request, and the log
goes silent for the whole stall, so the cause leaves no trace. While the tag is on, a
daemon thread asks the loop to stamp the time every ``POLL_S``; when the stamp is more
than ``STALL_S`` late it logs the loop thread's stack - the code holding the loop at
that moment - again every ``REPEAT_S`` while it lasts, and how long it lasted once the
loop is back.

Off, the loop does no work for it; the thread wakes every ``POLL_S`` to read one flag.
(``flow_sdk/server/run.py`` also has a SIGUSR1 all-thread dump; that one is manual.)
"""

from __future__ import annotations

import asyncio
import sys
import threading
import time
import traceback

from flow_sdk import toplog

TAG = "loop_stall"
POLL_S = 0.5
STALL_S = 2.0
REPEAT_S = 5.0
_STACK_FRAMES = 25

_last_stamp = time.monotonic()
_thread: threading.Thread | None = None


def _stamp() -> None:
    global _last_stamp
    _last_stamp = time.monotonic()


def _loop_stack(thread_id: int) -> str:
    frame = sys._current_frames().get(thread_id)
    if frame is None:
        return "<loop thread has no frame>"
    return "".join(traceback.format_stack(frame, limit=_STACK_FRAMES)).rstrip()


def _watch(loop: asyncio.AbstractEventLoop, thread_id: int) -> None:
    was_on = False
    stalled_since: float | None = None
    last_dump = 0.0
    while not loop.is_closed():
        time.sleep(POLL_S)
        if not toplog.is_on(TAG):
            was_on, stalled_since = False, None
            continue
        if not was_on:
            was_on = True
            _stamp()  # a stamp from before the tag went on is not a stall
        try:
            loop.call_soon_threadsafe(_stamp)
        except RuntimeError:  # the loop closed between the check and the call
            return
        now = time.monotonic()
        lag = now - _last_stamp
        if lag > STALL_S:
            if stalled_since is None:
                stalled_since = _last_stamp
            elif now - last_dump < REPEAT_S:
                continue
            last_dump = now
            toplog.log(TAG, "loop stalled %.1fs, loop thread is in:\n%s", lag, _loop_stack(thread_id))
        elif stalled_since is not None:
            toplog.log(TAG, "loop resumed after %.1fs stall", _last_stamp - stalled_since)
            stalled_since = None


def start() -> None:
    """Watch the running loop from a daemon thread. Call it on the loop's own thread."""
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _thread = threading.Thread(
        target=_watch,
        args=(asyncio.get_running_loop(), threading.get_ident()),
        name="loop-stall-watchdog",
        daemon=True,
    )
    _thread.start()
