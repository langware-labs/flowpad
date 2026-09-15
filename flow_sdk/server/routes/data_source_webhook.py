"""One webhook URL shape for every push-delivered data source: ``/api/v1/data_source/webhook/<name>``.

A source whose provider can only push (Meta's WhatsApp Cloud API lists nothing) declares it on its
class — ``webhook_challenge`` for the provider's one-time handshake, ``webhook_account`` and
``events_from_webhook`` for each delivery — and this route asks. It knows no provider.

**Two verbs, and they are different requests.** A provider calls ``GET`` once, when the webhook is
saved, and compares the echoed challenge byte for byte — so the answer is bare ``text/plain``, never
the API envelope. It calls ``POST`` forever after with the payload.

**Answer 200 to anything that parses.** Providers retry a non-2xx with backoff and replay the whole
batch, so a delivery for no source on this instance, or one carrying nothing we render, is a 200 with
a reason in the log rather than a failure. It reaches the store through the one ingestion chokepoint
the poller uses, so the digest gate and the ``ingest.*`` events apply exactly as for a polled source.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/data_source")


async def _pushing_type(name: str, verb: str):
    from flow_sdk.ingest.source_registry import resolve_source_type  # noqa: PLC0415

    stype = await resolve_source_type(name)
    return stype if stype is not None and hasattr(stype.cls, verb) else None


async def _rows(name: str) -> list:
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    return list(await DataSource.get_all({"provider": name}) or [])


@router.get("/webhook/{name}")
async def webhook_handshake(name: str, request: Request):
    """The provider's handshake. The class checks the offered token against every row's, in constant
    time: this endpoint is public by construction (a provider cannot carry a session)."""
    stype = await _pushing_type(name, "webhook_challenge")
    if stype is None:
        return PlainTextResponse("no webhook for this source", status_code=404)
    answer = stype.cls.webhook_challenge(dict(request.query_params), [row.config or {} for row in await _rows(name)])
    if answer is None:
        logger.warning("[webhook] %s verification refused: no source carries that token", name)
        return PlainTextResponse("verification failed", status_code=403)
    return PlainTextResponse(answer)


@router.post("/webhook/{name}")
async def webhook_delivery(name: str, request: Request):
    stype = await _pushing_type(name, "events_from_webhook")
    if stype is None:
        return ApiFailResponse(message=f"{name} takes no webhook deliveries")
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001 — a body that is not JSON is the caller's
        return ApiFailResponse(message="Expected a JSON object body")
    if not isinstance(payload, dict):
        return ApiFailResponse(message="Expected a JSON object body")
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    account = str(stype.cls.webhook_account(payload) or "")
    row = await DataSource.find_for_account(name, stype.identity_config_key, account) if account else None
    if row is None:
        # No amount of retrying makes a source exist; the log is where a person finds out.
        logger.warning("[webhook] %s delivery for %r matches no source on this instance", name, account)
        return ApiSuccessResponse(data={"ingested": 0, "reason": "no source for this account"})
    return ApiSuccessResponse(data=await stype.ingest_pushed(row, payload))


__all__ = ["router", "webhook_delivery", "webhook_handshake"]
