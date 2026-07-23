"""TopicEventBus — the backend bus core, a faithful port of the TS twin
(``ts_sdk/src/topics/EventBus.ts``). Same matching semantics, same laws:

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

from flow_sdk.topics.envelope import FlowEvent, FlowEventCtx
from flow_sdk.topics.grammar import (
    segments_match as _segments_match,
    topic_matches,
    topic_pattern_problem,
)

logger = logging.getLogger(__name__)

FlowEventHandler = Callable[[FlowEvent], Any]


def validate_bus_pattern(pattern: "str | None") -> Optional[str]:
    """THE bus-pattern grammar gate (shared by TOPIC triggers and flow
    subscriptions): a pointed problem string, or None when valid. Delegates to
    the shared grammar (``topics/grammar.py``), which also enforces per-segment
    validity — matching (``topic_matches``) itself never gates."""
    return topic_pattern_problem(pattern)


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
    topic trailing-``*``."""
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


def _log_task_exception(task: "asyncio.Task[Any]") -> None:
    try:
        exc = task.exception()
    except asyncio.CancelledError:
        return
    if exc is not None:
        logger.error("[EventBus] async handler failed", exc_info=exc)


# Observed-topics ring cap. Small and in-memory only: observation is a debug/
# gardening aid (the blessed-vs-anonymous diff), never a catalog — entities
# are minted deliberately, NEVER from observation.
_OBSERVED_CAP = 512


class TopicEventBus:
    """``tier`` is the origin this bus stamps on emits (the tier default lives
    at the bus seam, never on the envelope model)."""

    def __init__(self, tier: str = "local_server") -> None:
        self._tier = tier
        self._subs: dict[object, _Subscription] = {}
        # name → {count, first_ts, last_ts, last_target}; insertion-ordered,
        # drop-oldest at the cap. Dict pokes only — nothing else on the hot
        # path (no locks, no logging, no persistence).
        self._observed: "dict[str, dict[str, Any]]" = {}

    def _observe(self, topic: str, target: str) -> None:
        # Hot path: dict pokes + one time.time() C call only. Timestamps stay
        # epoch floats here; ISO formatting is deferred to observed_topics(),
        # which only the debug endpoint reads.
        stat = self._observed.get(topic)
        now = time.time()
        if stat is None:
            if len(self._observed) >= _OBSERVED_CAP:
                self._observed.pop(next(iter(self._observed)))
            self._observed[topic] = {
                "count": 1, "first_ts": now, "last_ts": now, "last_target": target,
            }
            return
        stat["count"] += 1
        stat["last_ts"] = now
        stat["last_target"] = target

    def observed_topics(self) -> dict[str, dict[str, Any]]:
        """Snapshot of topics seen on this bus since boot (bounded, in-memory).
        Formats the stored epoch floats to ISO-8601 here — the rare read path."""
        def _iso(epoch: float) -> str:
            return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat()

        return {
            name: {**stat, "first_ts": _iso(stat["first_ts"]), "last_ts": _iso(stat["last_ts"])}
            for name, stat in self._observed.items()
        }

    @staticmethod
    def _sub_matches(sub: _Subscription, topic_segments: list[str], target: str) -> bool:
        """The shared per-subscription predicate (pattern + target filter);
        the scope filter needs the built envelope, so it stays at the caller."""
        if sub.pattern != "*" and not _segments_match(sub.segments, topic_segments):
            return False
        if sub.target is not None and not target_matches(sub.target, target):
            return False
        return True

    def emit(self, topic: str, target: str, data: dict | None = None,
             ctx: dict | None = None) -> Optional[FlowEvent]:
        """Fire-and-forget. Mints id/timestamp and stamps this bus's TIER as
        ``ctx.origin`` unless the caller sets one. Returns the envelope when
        at least one subscriber matched, else None."""
        # Observation happens even with zero subscribers — seeing topics nobody
        # listens to yet is the whole point of the observed map.
        self._observe(topic, target)
        if not self._subs:
            return None
        event: Optional[FlowEvent] = None  # built lazily on the first match
        topic_segments = topic.split(".")
        for sub in list(self._subs.values()):
            if not self._sub_matches(sub, topic_segments, target):
                continue
            if event is None:
                event = FlowEvent(topic=topic, target=target, data=data or {},
                                  ctx=FlowEventCtx(**{"origin": self._tier, **(ctx or {})}))
            if sub.scope and not any(s in event.ctx.scope for s in sub.scope):
                continue
            self._dispatch(sub, event)
        return event

    def deliver(self, event: FlowEvent) -> None:
        """Dispatch a PRE-BUILT envelope (relay entry — id/timestamp/actor are
        never rewritten; the caller stamps ``origin`` per the arriving hop)."""
        topic_segments = event.topic.split(".")
        for sub in list(self._subs.values()):
            if not self._sub_matches(sub, topic_segments, event.target):
                continue
            if sub.scope and not any(s in event.ctx.scope for s in sub.scope):
                continue
            self._dispatch(sub, event)

    def _dispatch(self, sub: _Subscription, event: FlowEvent) -> None:
        try:
            result = sub.handler(event)
            if inspect.iscoroutine(result):
                # Law 3: emit never awaits consumers — async handlers become
                # loop tasks whose failures are logged, never raised here.
                asyncio.ensure_future(result).add_done_callback(_log_task_exception)
        except Exception:
            logger.exception("[EventBus] handler failed topic=%s target=%s",
                             event.topic, event.target)

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
event_bus = TopicEventBus()


def emit_topic(topic: str, target: str, data: dict | None = None,
               ctx: dict | None = None) -> Optional[FlowEvent]:
    return event_bus.emit(topic, target, data, ctx)


def on_topic(pattern: str, handler: FlowEventHandler, *,
             target: Optional[str] = None,
             scope: Optional[list[str]] = None) -> Callable[[], None]:
    return event_bus.on(pattern, handler, target=target, scope=scope)
