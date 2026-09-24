"""A process in the instance that is not the app hands its client-facing tags to the app.

The tag bus is per process, and only the app has clients: its WebSocket forwards the tags in
``FORWARDED_TAG_PATTERNS``. A local agent deployment runs its turns in its own process
(``builtin/agent_loop``), so what it emits — a reply sent, a message it would not answer — never
reached anyone. Here that process subscribes to what its watchers need (``RELAYED_TAG_PATTERNS``,
all of them forwarded to clients by the app) and posts each tag to the app
(``POST /api/v1/tags/relay``), which emits it on its own bus: every client-facing subscriber there,
the WebSocket included, then sees it exactly as if the app had emitted it.

Best-effort like the bus itself: a tag the app cannot take (not up, restarting) is dropped. The
durable record of what happened is the rows; a tag only says "look again now".
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from flow_sdk.tags.bus import FlowEvent, event_bus

#: What such a process emits that the app's clients watch: a deployment's timeline, a message placed
#: (its reply landing), a task's news, a live call. Not its channels' per-poll ``ingest.*.sync.*``
#: pair — a polled channel runs that every second, and nothing watching a deployment reads it.
RELAYED_TAG_PATTERNS: list[str] = [
    "deployment.timeline",
    "stream_inbox.*.message.projected",
    "task.*",
    "voice.call.*",
]

logger = logging.getLogger(__name__)

RELAY_PATH = "/api/v1/tags/relay"

_client = None
_started = False


def _app_url() -> Optional[str]:
    """This instance's app, from its ``server.json`` (the one ``FLOW_INSTANCE`` names)."""
    from flow_sdk.discovery.flowpad_discovery import read_server_info  # noqa: PLC0415

    info = read_server_info()
    return f"http://127.0.0.1:{info.port}{RELAY_PATH}" if info else None


async def _relay(event: FlowEvent) -> None:
    global _client
    url = _app_url()
    if url is None:
        return
    import httpx  # noqa: PLC0415

    if _client is None:
        _client = httpx.AsyncClient(timeout=5.0)
    try:
        await _client.post(url, json=event.model_dump(mode="json"))
    except (httpx.HTTPError, asyncio.CancelledError) as exc:
        if isinstance(exc, asyncio.CancelledError):
            raise
        logger.debug("tags: relay of %s to the app failed", event.tag, exc_info=True)


def start_relay_to_app() -> None:
    """Idempotent; called once by a process that is not the app (a deployment's loop)."""
    global _started
    if _started:
        return
    _started = True
    for pattern in RELAYED_TAG_PATTERNS:
        event_bus.on(pattern, _relay)
    logger.info("tags: relaying %s to the app", RELAYED_TAG_PATTERNS)


def emit_relayed(envelope: dict) -> None:
    """The app's half: emit a relayed envelope on this bus, keeping its target, data and context."""
    from flow_sdk.tags.grammar import tag_matches  # noqa: PLC0415

    tag = str(envelope.get("tag") or "")
    if not tag or not any(tag_matches(pattern, tag) for pattern in RELAYED_TAG_PATTERNS):
        # Only what is relayed — the relay is not a way to inject any tag into the app.
        raise ValueError(f"tag {tag!r} is not relayed")
    ctx = dict(envelope.get("ctx") or {})
    event_bus.emit(tag, str(envelope.get("target") or ""), envelope.get("data") or {}, ctx=ctx or None)

