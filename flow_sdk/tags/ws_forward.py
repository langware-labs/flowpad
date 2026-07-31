"""Backend→app tag forwarding — law 6: cross-tier by declared subscription.

One subscriber per pattern in ``FORWARDED_TAG_PATTERNS`` wraps each matching
FlowEvent in a ``tag_msg`` WS frame and broadcasts it. Strictly ONE-WAY
(nothing here re-emits onto the bus, so no relay cycle can exist); the
app→backend direction is deferred until the first real subscriber needs it
(docs/flow-events.md, phase-1 scope cut).

This module also keeps the **recent-envelope ring** that seeds the Signals feed
on open. It lives here rather than in the bus because the bus stores tag NAMES
only and, more importantly, because ``emit`` skips building an envelope at all
when nothing is subscribed (bus.py's zero-subscriber fast path — the reason
``entity.*`` costs one dict poke today). Recording here rides an envelope that
was already built for a tag already known to be app-visible, so the ring is
free: no hot-path change, and law 4 kept intact (persistence is a subscriber's
job, never the bus's).
"""
from __future__ import annotations

import json
import logging
from collections import deque
from typing import Any

from flow_sdk.tags.bus import event_bus
from flow_sdk.tags.envelope import FlowEvent

logger = logging.getLogger(__name__)

# The declared-forward allowlist. Phase 2 (flow-boundary emitter) is the first
# consumer; grow this list per-pattern, never wildcard-everything.
#
# `ingest.*.sync.*` and NOT `ingest.*` is deliberate. The per-item lane is
# bounded at STORM_CAP_PER_MINUTE (30) per stream and DEFAULT_STREAM_BUDGET (5)
# streams per source, i.e. up to 152 frames per source per cycle, with every due
# source firing on the same heartbeat tick — and broadcast() awaits one
# send_text per connected client, serially. That is the storm phase 3 refused
# for `entity.*`. The sync lane is exactly 2 frames per source per cycle
# regardless of item volume and already carries `changed_ids`, so the UI can
# hydrate the items on demand instead.
#
# `agent.status` is safe on the same test: it is emitted from the CHANGE-GATED
# status-report seam (agent_on_tag.py), so a running worker costs one frame per
# actual lifecycle transition — not one per turn and certainly not one per
# token. The Runs view needs it because a run launched outside a flow (an
# ingest driver's worker, an agent started from its profile) produces no
# `graph_workflow.*` at all.
FORWARDED_TAG_PATTERNS: list[str] = [
    "graph_workflow.*",
    "ingest.*.sync.*",
    "agent.status",
]

#: Envelopes retained for the Signals feed's initial paint. Bounded because the
#: bus persists nothing (law 4) — this is a debug tail, never a log.
RECENT_EVENTS_CAP = 200

#: Per-envelope payload budget. Two forwarded families carry unbounded `data`:
#: a node's `finished` detail holds stdout+stderr tails, and an agent node's
#: `done` carries the agent's ENTIRE output. Retaining those verbatim would pin
#: megabytes for the process lifetime whether or not anyone opens Signals — and
#: the feed only renders a one-line gist until a row is expanded.
MAX_RETAINED_DATA_CHARS = 2_000

_recent: "deque[dict[str, Any]]" = deque(maxlen=RECENT_EVENTS_CAP)

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


def recent_events() -> list[dict[str, Any]]:
    """Newest-last tail of forwarded envelopes, oldest first (feed order)."""
    return list(_recent)


def _retainable(event: FlowEvent) -> dict[str, Any]:
    """Serialize once, at record time, with an oversized payload elided.

    Dumping here rather than in ``recent_events`` means the ring holds plain
    dicts a reader can hand straight to the route, and — the point — a huge
    ``data`` never survives into long-lived memory.
    """
    dumped = event.model_dump(mode="json")
    data = dumped.get("data")
    if data is not None:
        rendered = json.dumps(data, default=str)
        if len(rendered) > MAX_RETAINED_DATA_CHARS:
            dumped["data"] = {
                "_elided": f"{len(rendered)} chars — read the record for the full payload",
            }
    return dumped


async def _forward(event: FlowEvent) -> None:
    # Recorded before the send: what reached the app is not the interesting
    # question here, and a client-side failure must not blind the feed.
    _recent.append(_retainable(event))
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
    _recent.clear()


__all__ = [
    "FORWARDED_TAG_PATTERNS", "RECENT_EVENTS_CAP",
    "start_tag_forwarding", "recent_events", "reset_for_tests",
]
