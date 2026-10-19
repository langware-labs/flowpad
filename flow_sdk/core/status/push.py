"""Tell the clients a status fact changed.

A signal, not a payload: the frame says "re-read", and the ``status`` GET stays the only
reader of the record. Coalesced, because a sweep or a sign-in writes several facts in a
burst and each client should re-read once.
"""

from __future__ import annotations

import asyncio
import json
import logging

logger = logging.getLogger(__name__)

#: How long a burst of writes may take before the one frame goes out.
_COALESCE_SECONDS = 0.2
_pending: asyncio.TimerHandle | None = None


async def _broadcast() -> None:
    from flow_sdk.api.api_types.messages import WSMessageType  # noqa: PLC0415
    from flow_sdk.server.routes.websocket import broadcast  # noqa: PLC0415

    try:
        await broadcast(json.dumps({"message_type": WSMessageType.STATUS_CHANGED_MSG.value}))
    except Exception as exc:  # noqa: BLE001 — a missed refresh signal must never fail a write
        logger.debug("status push failed: %s", exc)


def _fire() -> None:
    global _pending
    _pending = None
    asyncio.get_running_loop().create_task(_broadcast())


def publish_status_changed() -> None:
    """Schedule one ``status_changed_msg`` for this burst of writes. Safe from any coroutine."""
    global _pending
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # no loop (a CLI process): nobody is listening
    if _pending is None:
        _pending = loop.call_later(_COALESCE_SECONDS, _fire)
