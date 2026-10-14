"""A desktop webhook's deliveries, taken off this desktop's hub socket and replayed on this app.

A laptop has no address a provider (Meta) can call. The hub holds the public URL for it
(``webhook/create_for_desktop``), answers the provider's handshake itself, queues each delivery and pushes it
here as a ``webhook_delivery`` message. This replays it, byte for byte, on this instance's own route — the
same ``/api/v1/data_source/webhook/<name>`` a provider would call on a reachable machine, so the driver's
signature check and the one ingestion chokepoint apply unchanged — and acks it with what the route answered.
Until acked it stays queued on the hub and is pushed again on the next event, so a delivery id already
handled here is acked again rather than replayed twice.
"""
from __future__ import annotations

import asyncio
import base64
import logging
from collections import OrderedDict

logger = logging.getLogger(__name__)

#: Delivery ids handled here → the status this app answered. Bounded: the hub re-pushes only what it has not
#: had acked, which is a handful at a time.
_HANDLED: "OrderedDict[str, int]" = OrderedDict()
_HANDLED_CAP = 512
#: Hop-by-hop headers the local request makes for itself.
_DROP = frozenset({"host", "content-length", "transfer-encoding", "connection"})
#: Replays in flight, held so the loop never collects one mid-flight (and a test can await).
_tasks: "set[asyncio.Task]" = set()


async def on_delivery(message: dict) -> None:
    """The ``webhook_delivery`` handler: replay off the socket's read loop, so a slow route never stalls it."""
    task = asyncio.create_task(deliver(message))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def deliver(message: dict) -> int:
    """Replay one delivery here and ack it to the hub. Answers the status the route gave (502: unreachable)."""
    webhook_id = str(message.get("webhook_id") or "")
    delivery_id = str(message.get("delivery_id") or "")
    if not webhook_id or not delivery_id:
        logger.warning("[webhook-relay] a delivery without ids: %s", sorted(message))
        return 0
    status = _HANDLED.get(delivery_id)
    if status is None:
        status = await _replay(message)
        _HANDLED[delivery_id] = status
        while len(_HANDLED) > _HANDLED_CAP:
            _HANDLED.popitem(last=False)
    await _ack(webhook_id, delivery_id, status)
    return status


async def _replay(message: dict) -> int:
    import httpx  # noqa: PLC0415

    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    path = "/" + str(message.get("path") or "").lstrip("/")
    query = str(message.get("query") or "")
    url = f"http://127.0.0.1:{get_instance_settings().port}{path}" + (f"?{query}" if query else "")
    headers = [(k, v) for k, v in (message.get("headers") or []) if str(k).lower() not in _DROP]
    try:
        body = base64.b64decode(str(message.get("body_b64") or ""))
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            resp = await client.request(str(message.get("method") or "POST"), url, headers=headers, content=body)
        return resp.status_code
    except Exception as exc:  # noqa: BLE001 — an unreachable route is a status, the hub keeps the delivery
        logger.warning("[webhook-relay] replay of %s failed: %s", path, exc)
        return 502


async def _ack(webhook_id: str, delivery_id: str, status: int) -> None:
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

    try:
        await hub_post("webhook", {"delivery_id": delivery_id, "status": status}, webhook_id, "ack")
    except HubError as exc:
        # Not acked: the hub pushes it again on the next event, and it is acked from _HANDLED then.
        logger.warning("[webhook-relay] ack of %s refused: %s", delivery_id, exc)


async def catch_up() -> None:
    """This desktop (re)connected to the hub: ask it to push what waited while it was away."""
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

    try:
        await hub_post("webhook", {}, None, "catch_up")
    except HubError as exc:
        logger.debug("[webhook-relay] catch-up refused: %s", exc)
