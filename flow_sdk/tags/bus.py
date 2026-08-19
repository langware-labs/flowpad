"""TagEventBus — the backend bus core, a faithful port of the TS twin
(``ts_sdk/src/tags/EventBus.ts``). Same matching semantics, same laws:

* emit is SYNC fire-and-forget — it never awaits consumers. Sync handlers run
  inline behind try/except; async handlers are scheduled as loop tasks with a
  done-callback that logs their exceptions. One failing subscriber never
  blocks emit or its peers (law 3).
* Zero subscribers → not even an envelope allocation (adapters re-emit hot
  streams).
* ``deliver(event)`` is the RELAY entry: dispatches a pre-built envelope
  without re-minting id/timestamp (law: never rewritten on relay).
* No durability, no interpretation — persistence and meaning are subscriber
  jobs (laws 1, 4).

Contract-tested against the shared fixture
``tests/fixtures/flow_event_contract.json`` (same cases as the TS vitest).
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from flow_sdk.tags.envelope import FlowEvent, FlowEventCtx
from flow_sdk.tags.grammar import (
    segments_match as _segments_match,
    tag_matches,
    tag_pattern_problem,
)

logger = logging.getLogger(__name__)

FlowEventHandler = Callable[[FlowEvent], Any]


def validate_bus_pattern(pattern: "str | None") -> Optional[str]:
    """THE bus-pattern grammar gate (shared by TAG triggers and flow
    subscriptions): a pointed problem string, or None when valid. Delegates to
    the shared grammar (``tags/grammar.py``), which also enforces per-segment
    validity — matching (``tag_matches``) itself never gates."""
    return tag_pattern_problem(pattern)


class FixedWindowStormGuard:
    """Per-key fixed-window rate cap — THE storm-guard shape for bus
    subscribers (the bus itself has no budgets). One suppression callback per
    window, never silent. Keys are caller-defined (trigger id, flow id...)."""

    __slots__ = ("_window_s", "_windows")

    def __init__(self, window_s: float = 60.0) -> None:
        self._window_s = window_s
        # key → [window_start_monotonic, fires, suppression_signalled]
        self._windows: dict[str, list] = {}

    def allows(self, key: str, cap: int, on_suppress: Callable[[], None]) -> bool:
        import time

        now = time.monotonic()
        window = self._windows.setdefault(key, [now, 0, False])
        if now - window[0] > self._window_s:
            window[0], window[1], window[2] = now, 0, False
        window[1] += 1
        if window[1] <= max(1, cap):
            return True
        if not window[2]:
            window[2] = True
            on_suppress()
        return False

    def clear(self, key: str) -> None:
        self._windows.pop(key, None)


def target_matches(pattern: str, target: str) -> bool:
    """Exact match, or trailing ``*`` = prefix glob — ``agent:*`` (any of the
    type), ``dock:shell/*`` (any pointer under the view). Same grammar as the
    tag trailing-``*``."""
    if pattern == target or pattern == "*":
        return True
    if pattern.endswith("*"):
        return target.startswith(pattern[:-1])
    return False


class _Subscription:
    __slots__ = ("pattern", "segments", "handler", "target", "scope")

    def __init__(self, pattern: str, handler: FlowEventHandler,
                 target: Optional[str], scope: Optional[list[str]]) -> None:
        self.pattern = pattern
        # Pattern split once at subscribe time — emit is the hot path, not on().
        self.segments = pattern.split(".")
        self.handler = handler
        self.target = target
        self.scope = scope


#: Strong references to in-flight handler tasks.
#:
#: The event loop holds only WEAK references to tasks, so a bare
#: ``ensure_future(...)`` whose Task nobody keeps can be garbage-collected while
#: it is still awaiting — asyncio says so itself ("Save a reference to the result
#: of this function, to avoid a task disappearing mid-execution") and announces
#: the loss as ``Task was destroyed but it is pending!``. Short handlers usually
#: finish inside one GC cycle and hide it; a handler that awaits real work — a
#: spawned worker, an HTTP round trip — is the one that vanishes, and it vanishes
#: SILENTLY as far as its caller is concerned, because Law 3 already means nobody
#: is awaiting it. Holding the task here until it completes is what makes "emit
#: never awaits consumers" mean "runs independently" rather than "runs if the
#: collector does not get there first".
_INFLIGHT: "set[asyncio.Task[Any]]" = set()


def _log_task_exception(task: "asyncio.Task[Any]") -> None:
    try:
        exc = task.exception()
    except asyncio.CancelledError:
        return
    if exc is not None:
        logger.error("[EventBus] async handler failed", exc_info=exc)


# Observed-tags ring cap. Small and in-memory only: observation is a debug/
# gardening aid (the blessed-vs-anonymous diff), never a catalog — entities
# are minted deliberately, NEVER from observation.
_OBSERVED_CAP = 512


class TagEventBus:
    """``tier`` is the origin this bus stamps on emits (the tier default lives
    at the bus seam, never on the envelope model)."""

    def __init__(self, tier: str = "local_server") -> None:
        self._tier = tier
        self._subs: dict[object, _Subscription] = {}
        # name → {count, first_ts, last_ts, last_target}; insertion-ordered,
        # drop-oldest at the cap. Dict pokes only — nothing else on the hot
        # path (no locks, no logging, no persistence).
        self._observed: "dict[str, dict[str, Any]]" = {}

    def _observe(self, tag: str, target: str) -> None:
        # Hot path: dict pokes + one time.time() C call only. Timestamps stay
        # epoch floats here; ISO formatting is deferred to observed_tags(),
        # which only the debug endpoint reads.
        stat = self._observed.get(tag)
        now = time.time()
        if stat is None:
            if len(self._observed) >= _OBSERVED_CAP:
                self._observed.pop(next(iter(self._observed)))
            self._observed[tag] = {
                "count": 1, "first_ts": now, "last_ts": now, "last_target": target,
            }
            return
        stat["count"] += 1
        stat["last_ts"] = now
        stat["last_target"] = target

    def observed_tags(self) -> dict[str, dict[str, Any]]:
        """Snapshot of tags seen on this bus since boot (bounded, in-memory).
        Formats the stored epoch floats to ISO-8601 here — the rare read path."""
        def _iso(epoch: float) -> str:
            return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat()

        return {
            name: {**stat, "first_ts": _iso(stat["first_ts"]), "last_ts": _iso(stat["last_ts"])}
            for name, stat in self._observed.items()
        }

    @staticmethod
    def _sub_matches(sub: _Subscription, tag_segments: list[str], target: str) -> bool:
        """The shared per-subscription predicate (pattern + target filter);
        the scope filter needs the built envelope, so it stays at the caller."""
        if sub.pattern != "*" and not _segments_match(sub.segments, tag_segments):
            return False
        if sub.target is not None and not target_matches(sub.target, target):
            return False
        return True

    def emit(self, tag: str, target: str, data: dict | None = None,
             ctx: dict | None = None) -> Optional[FlowEvent]:
        """Fire-and-forget. Mints id/timestamp and stamps this bus's TIER as
        ``ctx.origin`` unless the caller sets one. Returns the envelope when
        at least one subscriber matched, else None."""
        # Observation happens even with zero subscribers — seeing tags nobody
        # listens to yet is the whole point of the observed map.
        self._observe(tag, target)
        if not self._subs:
            return None
        event: Optional[FlowEvent] = None  # built lazily on the first match
        tag_segments = tag.split(".")
        for sub in list(self._subs.values()):
            if not self._sub_matches(sub, tag_segments, target):
                continue
            if event is None:
                # Built on the first MATCHING sub (not merely the first sub) —
                # the laziness is the point. Tier-stamping lives in make_event.
                event = self.make_event(tag, target, data, ctx)
            if sub.scope and not any(s in event.ctx.scope for s in sub.scope):
                continue
            self._dispatch(sub, event)
        return event

    def make_event(self, tag: str, target: str, data: dict | None = None,
                   ctx: dict | None = None) -> FlowEvent:
        """Build an envelope WITHOUT dispatching it — the tier-stamping half of
        ``emit`` on its own.

        Exists so a caller that must know the envelope id *before* it is
        published (to write it onto a record, so the record and the envelope are
        the same fact) can get one unconditionally. ``emit`` cannot serve that:
        its zero-subscriber fast path returns None, so the id would be present
        only when somebody happened to be listening.

        Always go through here rather than constructing a ``FlowEvent`` at a call
        site — ``ctx.origin`` must keep coming from the bus TIER, which is the
        one thing a hand-built envelope always gets wrong (a worker or sandbox
        flow_sdk must not self-label ``local_server``).
        """
        return FlowEvent(tag=tag, target=target, data=data or {},
                         ctx=FlowEventCtx(**{"origin": self._tier, **(ctx or {})}))

    def publish(self, event: FlowEvent) -> FlowEvent:
        """Dispatch an envelope built here by ``make_event`` — the emit half.

        Observes (an emitted tag is seen whether or not anyone listens) and fans
        out, returning the same object so the caller can read its id. Distinct
        from ``deliver``, which is the RELAY entry for an envelope minted on
        another tier and deliberately does not observe.
        """
        self._observe(event.tag, event.target)
        self._fanout(event)
        return event

    def deliver(self, event: FlowEvent) -> None:
        """Dispatch a PRE-BUILT envelope (relay entry — id/timestamp/actor are
        never rewritten; the caller stamps ``origin`` per the arriving hop)."""
        self._fanout(event)

    def _fanout(self, event: FlowEvent) -> None:
        """The shared pre-built-envelope dispatch loop (publish + deliver)."""
        tag_segments = event.tag.split(".")
        for sub in list(self._subs.values()):
            if not self._sub_matches(sub, tag_segments, event.target):
                continue
            if sub.scope and not any(s in event.ctx.scope for s in sub.scope):
                continue
            self._dispatch(sub, event)

    def _dispatch(self, sub: _Subscription, event: FlowEvent) -> None:
        try:
            result = sub.handler(event)
            if inspect.iscoroutine(result):
                # Law 3: emit never awaits consumers — async handlers become
                # loop tasks whose failures are logged, never raised here. The
                # task is kept in `_INFLIGHT` until it finishes; see that set.
                task = asyncio.ensure_future(result)
                _INFLIGHT.add(task)
                task.add_done_callback(_INFLIGHT.discard)
                task.add_done_callback(_log_task_exception)
        except Exception:
            logger.exception("[EventBus] handler failed tag=%s target=%s",
                             event.tag, event.target)

    def on(self, pattern: str, handler: FlowEventHandler, *,
           target: Optional[str] = None,
           scope: Optional[list[str]] = None) -> Callable[[], None]:
        """Subscribe. Returns the unsubscriber — lifetime is the caller's job."""
        key = object()
        self._subs[key] = _Subscription(pattern, handler, target, scope)

        def _unsub() -> None:
            self._subs.pop(key, None)

        return _unsub

    def clear(self) -> None:
        """Test/teardown helper — drops every subscription."""
        self._subs.clear()


# The one backend-tier bus instance + the grep-able conveniences.
event_bus = TagEventBus()


def emit_tag(tag: str, target: str, data: dict | None = None,
               ctx: dict | None = None) -> Optional[FlowEvent]:
    return event_bus.emit(tag, target, data, ctx)


def make_tag_event(tag: str, target: str, data: dict | None = None,
                   ctx: dict | None = None) -> FlowEvent:
    return event_bus.make_event(tag, target, data, ctx)


def publish_tag(event: FlowEvent) -> FlowEvent:
    return event_bus.publish(event)


def on_tag(pattern: str, handler: FlowEventHandler, *,
             target: Optional[str] = None,
             scope: Optional[list[str]] = None) -> Callable[[], None]:
    return event_bus.on(pattern, handler, target=target, scope=scope)
