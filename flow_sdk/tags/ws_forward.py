"""Backend→app tag forwarding — law 6: cross-tier by declared subscription.

One subscriber per pattern in ``FORWARDED_TAG_PATTERNS`` wraps each matching
FlowEvent in a ``tag_msg`` WS frame and broadcasts it. Strictly ONE-WAY
(nothing here re-emits onto the bus, so no relay cycle can exist); the
app→backend direction is deferred until the first real subscriber needs it
(docs/flow-events.md, phase-1 scope cut).
"""
from __future__ import annotations

import logging

from flow_sdk.tags.bus import event_bus
from flow_sdk.tags.envelope import FlowEvent

logger = logging.getLogger(__name__)

# The declared-forward allowlist. Phase 2 (flow-boundary emitter) is the first
# consumer; grow this list per-pattern, never wildcard-everything.
FORWARDED_TAG_PATTERNS: list[str] = [
    "flow.*",
]

_started = False


def start_tag_forwarding() -> None:
    """Idempotent; called once from server startup."""
    global _started
    if _started:
        return
    _started = True
    for pattern in FORWARDED_TAG_PATTERNS:
        event_bus.on(pattern, _forward)
    logger.info("tags: backend→app forwarding armed for %s", FORWARDED_TAG_PATTERNS)


async def _forward(event: FlowEvent) -> None:
    try:
        from flow_sdk.api.messages import TagMessage
        from flow_sdk.server.routes.websocket import broadcast

        await broadcast(TagMessage(event=event.model_dump()).model_dump_json())
    except Exception:
        logger.debug("tags: ws forward unavailable", exc_info=True)


def reset_for_tests() -> None:
    """Drop the started latch (the bus itself is cleared by the test)."""
    global _started
    _started = False


__all__ = ["FORWARDED_TAG_PATTERNS", "start_tag_forwarding", "reset_for_tests"]
