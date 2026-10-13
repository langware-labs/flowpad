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

**One channel, by id, from the hub** — ``POST /<source id>/webhook``: an event a hub webhook claim routed
to THIS channel (``webhook/@<provider>`` → claim → this desktop / node). The hub already checked the
vendor's signature at its edge and cut a batch into one event per message, so the vendor's own signature no
longer covers what arrives: the hub is the trust here. It reaches this app only over the instance's own hub
socket (replayed on loopback) or through a box's cookie gate, which exempts no path. A source that is not
here answers 404 — the hub counts a misroute, never a delivery.

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

    stype = await DataDriver.find(name)
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
    rows = await _rows(name)
    source_id = request.query_params.get("source_id")
    if source_id:
        rows = [row for row in rows if str(row.id) == source_id]
        if not rows:
            return PlainTextResponse("no such source here", status_code=404)
    answer = stype.cls.webhook_challenge(dict(request.query_params), [row.config or {} for row in rows])
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
    from flow_sdk.schema.data_spec.webhook_spec import WebhookTargetSpec  # noqa: PLC0415

    targets_of = getattr(stype.cls, "webhook_targets", None)
    targets = targets_of(payload) if targets_of is not None else [
        WebhookTargetSpec(account=str(stype.cls.webhook_account(payload) or ""), payload=payload)
    ]
    selected = None
    source_id = request.query_params.get("source_id")
    if source_id:
        from flow_sdk.api.api_types.identifier import is_valid_uuid  # noqa: PLC0415

        if not is_valid_uuid(source_id):
            return PlainTextResponse("no such source here", status_code=404)
        selected = await DataSource.get_by_id(source_id)
        if selected is None or selected.provider != name:
            return PlainTextResponse("no such source here", status_code=404)
    matched = []
    for target in targets:
        if not target.account:
            continue
        if selected is None:
            row = await DataSource.find_for_account(name, stype.identity_config_key, target.account, part=target.part)
        else:
            # A callback for one project cannot silently select another project's account.
            key = stype.identity_config_key
            candidates = [(selected.config or {}).get(key)] if key else [selected.account_key, *(selected.account_identities or [])]
            if target.account not in {str(c or "").strip() for c in candidates}:
                continue
            part = stype.cls.account_part(selected.config or {})
            if part == target.part:
                row = selected
            elif not part and target.part:
                from flow_sdk.stream_inbox.projection import owner_of  # noqa: PLC0415

                owner = await owner_of(selected)
                row = await DataSource.find_for_account(name, key, target.account, part=target.part, owner=owner)
                if row is not None and await owner_of(row) != owner:
                    row = None
            else:
                row = None
        if row is not None:
            matched.append((row, target))
    if not matched:
        logger.warning("[webhook] %s delivery matches no source on this instance", name)
        return ApiSuccessResponse(data={"ingested": 0, "reason": "no source for this account"})
    # Authenticate the ORIGINAL signed body for EVERY target before ingesting any part.
    # No public caller can request the hub's trusted bypass, even by adding a header.
    authentic = getattr(stype.cls, "webhook_authentic", None)
    headers = {str(k).lower(): v for k, v in request.headers.items()}
    for row, _target in matched:
        credentials = await stype.credentials_for(row)
        if authentic is None or not authentic(headers, raw, credentials):
            return PlainTextResponse("signature did not verify", status_code=401)
    results = []
    for row, target in matched:
        try:
            result = await stype.ingest_pushed(row, target.payload, headers=headers, raw=raw)
        except Rejected:
            return PlainTextResponse("signature did not verify", status_code=401)
        calls = result.pop("calls", [])
        if calls:
            from flow_sdk.builtin.agent_calls import ring  # noqa: PLC0415

            result["rung"] = [call.call_id for call in calls if await ring(row, call)]
        reply = getattr(stype.cls, "webhook_reply", None)
        answer = reply(target.payload, row.config or {}) if reply is not None else None
        if answer is not None:
            body, media_type = answer
            return Response(content=body, media_type=media_type)
        results.append(result)
    if len(results) == 1:
        return ApiSuccessResponse(data=results[0])
    return ApiSuccessResponse(data={
        "ingested": sum(r.get("ingested", 0) for r in results),
        "created": sum(r.get("created", 0) for r in results),
        "reactions": sum(r.get("reactions", 0) for r in results),
        "ids": [key for r in results for key in r.get("ids", [])],
    })


@router.post("/{source_id}/webhook")
async def channel_delivery(source_id: str, request: Request):
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    row = await DataSource.get_by_id(source_id)
    stype = await _pushing_type(row.provider, "events_from_webhook") if row is not None else None
    if row is None or stype is None:
        logger.warning("[webhook] a hub delivery for channel %s, which is not on this instance", source_id)
        return PlainTextResponse("no such channel here", status_code=404)
    raw = await request.body()
    payload = _payload_of(raw, request.headers.get("content-type", ""))
    if payload is None:
        return ApiFailResponse(message="Expected a JSON object body")
    headers = dict(request.headers)
    nonce = str(request.headers.get("x-flowpad-probe") or "").strip()
    if nonce:
        phase = str(request.headers.get("x-flowpad-probe-phase") or "").strip()
        if phase == "route":
            return ApiSuccessResponse(data=await _answer_route_probe(row, nonce, request.headers.get("x-flowpad-probe-claim") or ""))
        if phase == "agent":
            from flow_sdk.builtin.agent_serve import admit_probe  # noqa: PLC0415

            admit_probe(str(row.id), f"probe-{nonce}")
    result = await stype.ingest_pushed(row, payload, headers=headers, raw=raw, verified_by_hub=True)
    result.pop("calls", None)
    return ApiSuccessResponse(data=result)


async def _answer_route_probe(row, nonce: str, claim_id: str) -> dict:
    """A hub connection probe's ``route`` leg: tell the hub who would answer this channel and where —
    ``"<agent> @ <place>"`` — without taking the message in."""
    from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

    text = f"{await _answerer_of(row)} @ {await _place_of(row)}"
    await hub_post("webhook", {"event_id": nonce, "text": text}, str(claim_id), "reply")
    return {"probe": nonce, "text": text}


async def _answerer_of(row) -> str:
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415

    owner = str(getattr(row, "owner", "") or "")
    agent = await Agent.get_by_id(owner.split("-", 1)[1]) if owner.startswith("agent-") else None
    return str(getattr(agent, "name", "") or "") if agent is not None else "nobody"


async def _place_of(row) -> str:
    """The label of the place that answers: the source's ``answer_place`` among its route places, else
    this computer — the delivery reached it here."""
    place = str(getattr(row, "answer_place", "") or "")
    places = await row.route_places() if place else []
    return next((p["label"] for p in places if p["key"] == place), "This computer")


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
