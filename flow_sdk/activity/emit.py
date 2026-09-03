"""The sink: coalesce activity ticks and put them on the wire.

The core (``activity.py`` / ``progress_monitor.py``) notifies on EVERY mutation and knows nothing
about transport. That split is what lets a walk report a hundred thousand times without
a hundred thousand sockets writes: the cost of deciding what actually goes out belongs
here, where there is an event loop to defer with.

Two channels, and the difference is the whole reason ticks are cheap:

* **Ticks** ride the shared ``progress_report`` FlowData envelope, coalesced to
  :data:`TICK_INTERVAL_S`, and touch nothing else. No database, no event bus.
* **Transitions** — started, blocked, completed, failed — publish once, immediately, on
  the event bus, and are never coalesced away.

Coalescing keeps a TRAILING edge. A throttled tick that is never followed by another
would otherwise leave the last increments invisible until the activity ended, which is
exactly the state a user stares at when a job slows down.

Routing is by scope. An activity with no scope belongs to the instance and goes to every
connection; one scoped to an entity goes to that entity's watchers. The old
``broadcast_progress`` had no watcher filter at all, which was tolerable when the only
producer was a single instance-wide index and is not once every process has activities.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from flow_sdk.activity.activity import Activity
from flow_sdk.activity.progress_monitor import monitor
from flow_sdk.schema.data_spec.activity_spec import ActivityProgressSpec

logger = logging.getLogger(__name__)

#: Four ticks a second per root. Fast enough that a bar moves smoothly, slow enough that
#: a tight walk cannot flood the socket. Not a timeout or a retry budget — it is the
#: sampling rate of a live view, and lowering it never hides an error.
TICK_INTERVAL_S = 0.25

#: The FlowData element every progress payload rides, shared with the indexer's table and
#: the agentic-process status report. ``attributes`` here is an ``ActivityProgressSpec``.
PROGRESS_ELEMENT = "progress_report"

#: Marks an envelope as an activity snapshot rather than one of the older payloads on the
#: same element. Mirrored on the frontend as ``ACTIVITY_KIND``.
ACTIVITY_KIND = "activity"

def local_scope_typeid() -> str:
    """Where an instance-wide activity is addressed: this machine's ComputeNode.

    The client DROPS any flow_data message whose ``to_entity`` will not parse as a TypeId
    (``ConnectionManager.onFlowDataMessage``), so an empty string is not "no particular
    entity" — it is a frame nobody ever sees.

    Built from ``local_entity_id``, the same pure per-machine function
    ``ComputeNode._local_id`` uses, rather than the ``@local`` alias: the indexer addresses
    its own progress with ``str(self.typeid)``, and two spellings of one box would mean two
    addresses for the same activity stream once phase 2 puts them side by side.
    """
    from flow_sdk.utils.machine_id import local_entity_id

    return f"compute_node-{local_entity_id('compute_node')}"


def envelope(spec: ActivityProgressSpec) -> dict:
    """The wire form: a ``progress_report`` element whose attributes are the spec.

    The dump is mutated in place rather than spread into a new dict — ``model_dump``
    already allocated a fresh tree, and spreading it copies the top level a second time on
    every frame.
    """
    attrs = spec.model_dump(mode="json")
    attrs["kind"] = ACTIVITY_KIND
    return {"element_type": PROGRESS_ELEMENT, "attributes": attrs}


class ActivityEmitter:
    """Coalesces ticks per root and hands them to the transport.

    One instance, installed on the monitor at server start via :func:`install`.
    """

    def __init__(self, interval_s: float = TICK_INTERVAL_S) -> None:
        self._interval = interval_s
        #: Roots with a tick owed. Keyed by address so a re-entry coalesces rather than
        #: queueing a second flush for the same tree.
        self._pending: "dict[tuple[Optional[str], str], Activity]" = {}
        self._task: "Optional[asyncio.Task]" = None
        self._loop: "Optional[asyncio.AbstractEventLoop]" = None
        self._unsubscribe = None
        #: Strong references to in-flight sends. ``loop.create_task`` returns a task the
        #: loop only WEAKLY references, so a send nobody holds can be garbage-collected
        #: mid-flight and simply never happen. That is not theoretical: it ate exactly the
        #: transition frames — the ticks survived because the coalescing task kept the loop
        #: busy around them — so a finished activity stayed "running" in the UI forever
        #: while the backend had already evicted it.
        self._in_flight: "set[asyncio.Task]" = set()

    # ------------------------------------------------------------------ wiring

    def install(self) -> None:
        """Subscribe to the monitor. Idempotent."""
        if self._unsubscribe is not None:
            return
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None
        self._unsubscribe = monitor.subscribe(self._on_change)

    def uninstall(self) -> None:
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None
        if self._task is not None:
            self._task.cancel()
            self._task = None
        for task in list(self._in_flight):
            task.cancel()
        self._in_flight.clear()
        self._pending.clear()

    # ------------------------------------------------------------------ sink

    def _on_change(self, root: Activity, transition: bool) -> None:
        """Monitor callback. Runs in the PRODUCER's thread, so it must be cheap.

        Note what is not done here: the spec is not built. Building one walks the
        subtree, and on a tick that is about to be coalesced away that work would be
        thrown out. A transition builds immediately because it is emitted immediately —
        and because a terminal root is evicted right after this returns, so deferring it
        would serialise a tree that no longer exists.
        """
        if transition:
            self._emit(root.spec())
            return
        self._pending[(root.scope, root.path)] = root
        self._schedule()

    def _schedule(self) -> None:
        if self._task is not None and not self._task.done():
            return
        loop = self._loop or _running_loop()
        if loop is None:
            # No loop at all (a unit test, or a producer in a process without one). The
            # tick stays pending and rides out with the next flush or the transition; a
            # progress view is a sampled view, and sampling is not dropping.
            return
        self._task = self._spawn(loop, self._flush_soon())

    def _spawn(self, loop: "asyncio.AbstractEventLoop", coro) -> "Optional[asyncio.Task]":
        """Start ``coro`` on ``loop``, from whichever thread we happen to be on.

        Producers are not all async: a walk runs in a worker thread and reports from
        there. ``loop.create_task`` is NOT thread-safe, so calling it cross-thread is
        undefined behaviour rather than an error you would ever see — the safe hop is
        ``call_soon_threadsafe``, at the cost of not getting the Task object back.
        """
        if _running_loop() is loop:
            return loop.create_task(coro)
        try:
            loop.call_soon_threadsafe(lambda: self._track(loop.create_task(coro)))
        except RuntimeError:  # loop already closed — shutdown, nothing to report to
            coro.close()
        return None

    def _track(self, task: "asyncio.Task") -> None:
        """Hold a task created on the loop thread until it finishes. See ``_in_flight``."""
        self._in_flight.add(task)
        task.add_done_callback(self._in_flight.discard)

    async def _flush_soon(self) -> None:
        """Wait one interval, then emit everything that accumulated — the trailing edge.

        Sleeping the interval and flushing after is what makes a burst of ten thousand
        increments cost one emit, and what guarantees the LAST of them is seen even
        though nothing follows it.
        """
        try:
            await asyncio.sleep(self._interval)
        except asyncio.CancelledError:  # pragma: no cover - shutdown
            return
        pending, self._pending = self._pending, {}
        for root in pending.values():
            self._emit(root.spec())

    def _emit(self, spec: ActivityProgressSpec) -> None:
        loop = self._loop or _running_loop()
        if loop is None:
            return
        # Hold the task until it finishes — see ``_in_flight``. Dropping the reference is
        # how a transition frame silently never reaches the client.
        task = self._spawn(loop, _send(spec))
        if task is not None:
            self._track(task)


def _running_loop() -> "Optional[asyncio.AbstractEventLoop]":
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


async def _send(spec: ActivityProgressSpec) -> None:
    """Put one snapshot on the socket, addressed by scope.

    Two sends, and which one is used IS the routing rule:

    * **No scope** — the work belongs to the box (an index, a walk, a docs scan), so
      every connection gets it. ``broadcast_progress`` has no watcher filter, which is
      correct here and only here. It is still ADDRESSED, to this machine's ComputeNode:
      the client drops a frame whose ``to_entity`` does not parse as a TypeId.
    * **A scope** — the work belongs to one entity, so only that entity's watchers get
      it. Broadcasting a process's activity to everyone is a volume problem on a busy
      box and, on a shared hub, a privacy one.

    Imported lazily: ``flow_sdk.activity`` stays importable with no server, which is
    what keeps the core unit-testable without standing one up.
    """
    try:
        if spec.scope:
            from flow_sdk.core.network.resource_tracker import send_flow_data_to_entity

            await send_flow_data_to_entity(spec.scope, envelope(spec))
        else:
            from flow_sdk.core.network.resource_tracker import broadcast_progress

            await broadcast_progress(local_scope_typeid(), envelope(spec))
    except Exception:  # noqa: BLE001 — reporting must never fail a producer
        logger.debug("activity emit failed for %s", spec.path, exc_info=True)


#: The one emitter. ``install()`` it from server startup.
emitter = ActivityEmitter()


def install() -> None:
    """Start putting activity snapshots on the wire. Call once, from server startup."""
    emitter.install()


__all__ = [
    "ACTIVITY_KIND",
    "local_scope_typeid",
    "PROGRESS_ELEMENT",
    "TICK_INTERVAL_S",
    "ActivityEmitter",
    "emitter",
    "envelope",
    "install",
]
