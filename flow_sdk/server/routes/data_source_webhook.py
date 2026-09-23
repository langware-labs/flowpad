"""One webhook URL shape for every push-delivered data source: ``/api/v1/data_source/webhook/<name>``.

A source whose provider can only push (Meta's WhatsApp Cloud API lists nothing) declares it on its
class — ``webhook_challenge`` for the provider's one-time handshake, ``webhook_account`` and
``events_from_webhook`` for each delivery, ``webhook_authentic`` when the provider signs its
deliveries — and this route asks. It knows no provider.

**Two verbs, and they are different requests.** A provider calls ``GET`` once, when the webhook is
saved, and compares the echoed challenge byte for byte — so the answer is bare ``text/plain``, never
the API envelope. It calls ``POST`` forever after with the payload.

**Answer 200 to anything that parses.** Providers retry a non-2xx with backoff and replay the whole
batch, so a delivery for no source on this instance, or one carrying nothing we render, is a 200 with
a reason in the log rather than a failure. It reaches the store through the one ingestion chokepoint
the poller uses, so the digest gate and the ``ingest.*`` events apply exactly as for a polled source.

**Calls.** A source people talk to live (``Calling``) may ring a call in a delivery
(``calls_from_webhook``); each is handed to whoever answers the source (``agent_calls.ring``). A
provider that dials by webhook and wants instructions back (a phone carrier asking what to do with
a call) gets them from the class's ``webhook_reply`` — the one case the answer is not the envelope.
A carrier posts a form, not JSON; a form body is read as its fields.

``POST /<source id>/call`` starts a call from our side — a browser's SDP offer, a sound file, a
number to dial — through the source's ``start_call``, and answers what the starter needs (an SDP
answer, the call id) in the envelope; ``POST /<source id>/call/<call id>/hangup`` ends it.
"""
from __future__ import annotations

import json
import logging
from urllib.parse import parse_qsl

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse, Response

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse
from flow_sdk.sources.errors import Rejected, SourceError

logger = logging.getLogger(__name__)

# FROZEN: providers hold this URL. It is not the entity type (now ``data_driver``) and must not follow it.
router = APIRouter(prefix="/api/v1/data_source")


async def _pushing_type(name: str, verb: str):
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    stype = await DataDriver.get(name)
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
    # The raw bytes, not a re-serialisation: a provider signs exactly what it sent.
    raw = await request.body()
    payload = _payload_of(raw, request.headers.get("content-type", ""))
    if payload is None:
        return ApiFailResponse(message="Expected a JSON object body")
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    account = str(stype.cls.webhook_account(payload) or "")
    row = await DataSource.find_for_account(name, stype.identity_config_key, account) if account else None
    if row is None:
        # No amount of retrying makes a source exist; the log is where a person finds out.
        logger.warning("[webhook] %s delivery for %r matches no source on this instance", name, account)
        return ApiSuccessResponse(data={"ingested": 0, "reason": "no source for this account"})
    # The URL is public: an unverified body would put words in an allowed sender's mouth and drive
    # an agent. The source type refuses one its class cannot authenticate.
    try:
        result = await stype.ingest_pushed(row, payload, headers=request.headers, raw=raw)
    except Rejected:
        logger.warning("[webhook] %s delivery for %r refused: the signature did not verify", name, account)
        return PlainTextResponse("signature did not verify", status_code=401)
    calls = result.pop("calls", [])
    if calls:
        from flow_sdk.builtin.agent_calls import ring  # noqa: PLC0415

        result["rung"] = [call.call_id for call in calls if await ring(row, call)]
    reply = getattr(stype.cls, "webhook_reply", None)
    answer = reply(payload, row.config or {}) if reply is not None else None
    if answer is not None:
        body, media_type = answer
        return Response(content=body, media_type=media_type)
    return ApiSuccessResponse(data=result)


@router.post("/{source_id}/call")
async def start_call(source_id: str, request: Request):
    """Start a call on a source from our side. Body ``{"offer": {...}}`` — what the source's
    ``start_call`` reads (``sdp`` from a browser, a sound file, a number to dial)."""
    from flow_sdk.builtin.agent_calls import ring  # noqa: PLC0415
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    row = await DataSource.get_by_id(source_id)
    if row is None:
        return ApiFailResponse(message=f"no data source {source_id}")
    driver = DataDriver.loaded(row.provider)
    if driver is None or not hasattr(driver.cls, "start_call"):
        return ApiFailResponse(message=f"{row.provider} takes no calls")
    try:
        body = json.loads(await request.body() or b"{}")
    except ValueError:
        return ApiFailResponse(message="Expected a JSON object body")
    offer = body.get("offer") if isinstance(body, dict) else None
    if not isinstance(offer, dict):
        return ApiFailResponse(message="Expected {\"offer\": {...}}")
    source = await driver.open(row)
    try:
        async with source:
            answer, call = await source.start_call(offer)  # type: ignore[attr-defined]
    except (ValueError, SourceError) as exc:
        return ApiFailResponse(message=str(exc))
    if call is not None and not await ring(row, call):
        return ApiFailResponse(message="nothing on this machine answers this source's calls")
    return ApiSuccessResponse(data={**answer, "call_id": call.call_id if call is not None else answer.get("call_id", "")})


@router.post("/{source_id}/call/{call_id}/hangup")
async def hang_up(source_id: str, call_id: str):
    """End a call on this machine — the side that holds the call ends it, so the provider closes the
    line and the call is recorded as ended, whichever end the person hung up from."""
    from flow_sdk.builtin.agent_calls import active_calls, hangup  # noqa: PLC0415

    held = active_calls().get(call_id)
    if held is None or held.get("source_id") != source_id:
        return ApiSuccessResponse(data={"hung_up": False, "reason": "no such call on this source here"})
    return ApiSuccessResponse(data={"hung_up": await hangup(call_id)})


def _payload_of(raw: bytes, content_type: str):
    """A delivery's body as a dict: JSON, or a form's fields (a carrier posts a form). ``None`` if neither."""
    if "application/x-www-form-urlencoded" in content_type.lower():
        return dict(parse_qsl(raw.decode("utf-8", "replace"), keep_blank_values=True))
    try:
        payload = json.loads(raw)
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


__all__ = ["hang_up", "router", "start_call", "webhook_delivery", "webhook_handshake"]
