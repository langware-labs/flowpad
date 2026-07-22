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
from typing import Any, Callable, Optional

from flow_sdk.topics.envelope import FlowEvent, FlowEventCtx

logger = logging.getLogger(__name__)

FlowEventHandler = Callable[[FlowEvent], Any]


def _segments_match(p: list[str], t: list[str]) -> bool:
    for i, seg in enumerate(p):
        if seg == "*" and i == len(p) - 1:
            return len(t) >= i + 1
        if i >= len(t):
            return False
        if seg != "*" and seg != t[i]:
            return False
    return len(t) == len(p)


def topic_matches(pattern: str, topic: str) -> bool:
    """Segment-wise glob over the dot path. ``*`` matches exactly one segment;
    a TRAILING ``*`` matches any remaining suffix (``app.*`` matches
    ``app.route.loaded``). No partial-segment matching."""
    if pattern == "*":
        return True
    return _segments_match(pattern.split("."), topic.split("."))


def target_matches(pattern: str, target: str) -> bool:
    """Exact match, or ``type:*`` — pattern up to the first colon, then ``*``."""
    if pattern == target or pattern == "*":
        return True
    if pattern.endswith(":*"):
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


class TopicEventBus:
    def __init__(self) -> None:
        self._subs: dict[object, _Subscription] = {}

    def emit(self, topic: str, target: str, data: dict | None = None,
             ctx: dict | None = None) -> Optional[FlowEvent]:
        """Fire-and-forget. Mints id/timestamp, defaults ``ctx.origin`` to
        ``local_server`` (this is the backend tier). Returns the envelope when
        at least one subscriber matched, else None."""
        if not self._subs:
            return None
        event: Optional[FlowEvent] = None  # built lazily on the first match
        topic_segments = topic.split(".")
        for sub in list(self._subs.values()):
            if sub.pattern != "*" and not _segments_match(sub.segments, topic_segments):
                continue
            if sub.target is not None and not target_matches(sub.target, target):
                continue
            if event is None:
                event = FlowEvent(topic=topic, target=target, data=data or {},
                                  ctx=FlowEventCtx(**(ctx or {})))
            if sub.scope and not any(s in event.ctx.scope for s in sub.scope):
                continue
            self._dispatch(sub, event, topic, target)
        return event

    def deliver(self, event: FlowEvent) -> None:
        """Dispatch a PRE-BUILT envelope (relay entry — id/timestamp/actor are
        never rewritten; the caller stamps ``origin`` per the arriving hop)."""
        topic_segments = event.topic.split(".")
        for sub in list(self._subs.values()):
            if sub.pattern != "*" and not _segments_match(sub.segments, topic_segments):
                continue
            if sub.target is not None and not target_matches(sub.target, event.target):
                continue
            if sub.scope and not any(s in event.ctx.scope for s in sub.scope):
                continue
            self._dispatch(sub, event, event.topic, event.target)

    def _dispatch(self, sub: _Subscription, event: FlowEvent,
                  topic: str, target: str) -> None:
        try:
            result = sub.handler(event)
            if inspect.iscoroutine(result):
                # Law 3: emit never awaits consumers — async handlers become
                # loop tasks whose failures are logged, never raised here.
                asyncio.ensure_future(result).add_done_callback(_log_task_exception)
        except Exception:
            logger.exception("[EventBus] handler failed topic=%s target=%s", topic, target)

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
