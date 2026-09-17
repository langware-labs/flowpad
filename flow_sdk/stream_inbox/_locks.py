"""One per-event-loop lock idiom, shared by the inbox lanes.

An ``asyncio.Lock`` is loop-scoped, and a single module-level Lock breaks under
per-test event loops: a loop torn down while a fire-and-forget task holds the
lock leaves it locked and bound to a dead loop forever, and every later acquire
from a new loop raises "bound to a different event loop". Keying the lock by
the RUNNING loop in a weak-keyed table sidesteps both; in the backend's single
long-lived loop this is identical to one Lock.

Extracted because the unread projection and the thread projector each grew a
byte-identical copy — a third was inevitable.
"""
from __future__ import annotations

import asyncio
import weakref

Registry = "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]"


def new_registry() -> "weakref.WeakKeyDictionary":
    return weakref.WeakKeyDictionary()


def loop_lock(registry: "weakref.WeakKeyDictionary") -> asyncio.Lock:
    """The calling loop's lock from ``registry``, created on first use."""
    loop = asyncio.get_running_loop()
    lock = registry.get(loop)
    if lock is None:
        lock = asyncio.Lock()
        registry[loop] = lock
    return lock
