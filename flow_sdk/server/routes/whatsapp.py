"""Meta's WhatsApp webhook — the only way a message arrives.

The Cloud API publishes no endpoint that lists messages, so unlike every other
message source there is nothing for the poller to call: this route IS the
ingestion trigger. What it is not is a second ingestion path — it translates
Meta's envelope into ``SourceItemSpec`` and hands it to ``ingest_items``, the
same chokepoint the poller and ``flow record create`` write through, so the
digest gate, the local-state preservation and the ``ingest.*`` events all apply
exactly as they do to a polled source.

**Two verbs, and they are different requests.** Meta calls ``GET`` once, when
you save the webhook, echoing back a challenge if the verify token matches; it
calls ``POST`` forever after with the messages. Both live here because they are
one URL as far as Meta is concerned.

**Answer 200 to anything that parses.** Meta RETRIES a non-2xx, with backoff,
and keeps retrying — so a batch containing one message shape we do not render
must not fail the request, or Meta replays the whole batch until it gives up
and drops it. The translation is deliberately total: unknown shapes yield no
items, not an error.
"""

from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/whatsapp")


async def _source_for(phone_number_id: str):
    """The DataSource watching this business number, or ``None``.

    Looked up by the driver's own ``identity_config_key`` so one instance can
    serve several numbers on one URL — Meta sends the id in the payload, and it
    is the only thing in the request that says which source a message belongs
    to.
    """
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    if not phone_number_id:
        return None
    for row in await DataSource.get_all({"provider": "whatsapp"}):
        if str((getattr(row, "config", None) or {}).get("phone_number_id") or "") == phone_number_id:
            return row
    return None


@router.get("/webhook")
async def verify_webhook(request: Request):
    """Meta's one-time handshake: echo ``hub.challenge`` if the token matches.

    The response is the bare challenge as ``text/plain`` — not the API envelope
    every other route returns. Meta compares the body byte for byte, so a JSON
    wrapper here reads as a failed verification with no explanation.

    The token is matched against every WhatsApp source, in constant time: this
    endpoint is public and unauthenticated by construction (Meta cannot carry a
    session), so a wrong guess must not be distinguishable by how long the
    refusal took.
    """
    params = request.query_params
    if params.get("hub.mode") != "subscribe":
        return PlainTextResponse("unexpected mode", status_code=400)

    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    offered = params.get("hub.verify_token") or ""
    matched = False
    for row in await DataSource.get_all({"provider": "whatsapp"}):
        expected = str((getattr(row, "config", None) or {}).get("verify_token") or "")
        if expected and hmac.compare_digest(expected, offered):
            matched = True
    if not matched:
        logger.warning("[whatsapp] webhook verification refused: no source carries that verify token")
        return PlainTextResponse("verification failed", status_code=403)
    return PlainTextResponse(params.get("hub.challenge") or "")


@router.post("/webhook")
async def receive_webhook(request: Request):
    """One batch of messages, straight into the ingestor.

    Returns 200 for everything it can parse — including a batch that yields no
    items, which is the normal case for delivery receipts. See the module note
    on why a failure here is worse than a dropped record.
    """
    from flow_sdk.ingest.drivers.whatsapp import items_from_webhook  # noqa: PLC0415
    from flow_sdk.ingest.ingestor import ingest_items  # noqa: PLC0415

    try:
        payload = await request.json()
    except Exception:
        return ApiFailResponse(message="Expected a JSON object body")
    if not isinstance(payload, dict):
        return ApiFailResponse(message="Expected a JSON object body")

    phone_number_id = _phone_number_id(payload)
    source = await _source_for(phone_number_id)
    if source is None:
        # 200, not 404: Meta retries a failure, and no amount of retrying will
        # make a source exist. The log is where a person finds out they pointed
        # a webhook at an instance that does not watch that number.
        logger.warning("[whatsapp] webhook for %r matches no source on this instance", phone_number_id)
        return ApiSuccessResponse(data={"ingested": 0, "reason": "no source for this number"})

    items = items_from_webhook(source, payload)
    if not items:
        return ApiSuccessResponse(data={"ingested": 0})
    report = await ingest_items(items)
    return ApiSuccessResponse(data={"ingested": len(items), "created": getattr(report, "created", 0)})


def _phone_number_id(payload: dict) -> str:
    """Which business number this batch is about.

    Meta nests it three deep and repeats it per change; the first one wins
    because a single POST is always about one number.
    """
    for entry in payload.get("entry") or []:
        if not isinstance(entry, dict):
            continue
        for change in entry.get("changes") or []:
            if not isinstance(change, dict):
                continue
            value = change.get("value")
            metadata = value.get("metadata") if isinstance(value, dict) else None
            if isinstance(metadata, dict) and metadata.get("phone_number_id"):
                return str(metadata["phone_number_id"])
    return ""
