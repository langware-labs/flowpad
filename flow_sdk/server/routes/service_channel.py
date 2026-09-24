"""A ``channel`` ServiceEndpoint: an HTTP request is a message on a channel, its reply the answer.

``ServiceEndpoint (HTTP) → message channel (a DataSource) → whoever answers it → the reply``. The
route knows the endpoint's protocol, never the channel's provider: it hands the request to the
source's driver (``events_from_request``), ingests what that yields through the one ingestion
chokepoint, and answers with the reply the channel records in the same thread
(``SourceItem.find_reply_from_self``) — shaped by the driver (``reply_payload``). Who answers the
channel — an agent deployment's loop, in its own process — is not this route's business; the
database is the only thing the two share.

A deployed agent's ``chat`` endpoint is one (``api.chat.openai``):

* ``POST v1/chat/completions`` — the last ``user`` message is the message. ``metadata.conversation_id``
  continues a conversation (omitted, one is started); every answer names it
  (``flowpad.conversation_id`` and ``X-Flowpad-Conversation``). A conversation is the caller's own.
  ``stream`` answers Server-Sent Events (OpenAI chunk shape) carrying the reply once it is recorded.
* ``GET v1/conversations/<id>`` — the caller's conversation so far (``{messages}``), from the channel.
* ``GET v1/models`` — the one model: this endpoint.

No reply within ``REPLY_DEADLINE_SECONDS`` is a 504 naming the conversation — the message stays in
the channel and is answered when its loop gets to it.
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import Optional

from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

#: How long one HTTP request waits for its reply — the request/response contract, not a retry budget.
REPLY_DEADLINE_SECONDS = 60.0
#: How often the waiting request looks for the reply the answering process recorded: soon at
#: first, then no more than once a second — a turn takes seconds, and each look is a query.
_REPLY_CHECKS = (0.1, 0.2, 0.4, 0.8, 1.0)
_LOCAL_CALLER = "local"


def _fail(status: int, message: str, kind: str = "invalid_request_error", **extra) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"message": message, "type": kind, **extra}})


def _model(endpoint) -> str:
    return f"endpoint-{endpoint.id}"


async def channel_http(request: Request, endpoint, sub_path: str, caller: Optional[str]) -> Response:
    """Answer one request on a ``channel`` endpoint (``endpoint.backend.type == "channel"``)."""
    path = sub_path.strip("/")
    if path.startswith("v1/"):
        path = path[3:]
    if request.method == "GET" and path == "models":
        return JSONResponse({"object": "list", "data": [{"id": _model(endpoint), "object": "model", "owned_by": "flowpad"}]})
    if request.method == "POST" and path == "chat/completions":
        return await _completions(request, endpoint, caller or _LOCAL_CALLER)
    if request.method == "GET" and path.startswith("conversations/"):
        return await _history(endpoint, caller or _LOCAL_CALLER, path.partition("/")[2])
    return _fail(404, f"no {request.method} {sub_path} on this endpoint")


async def _channel(endpoint):
    """The endpoint's source and its driver, or ``None`` when either is gone."""
    from flow_sdk.builtin.agent_serve import is_request_channel  # noqa: PLC0415
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    source = await DataSource.get_by_id(endpoint.backend.data_source_id)
    driver = DataDriver.loaded(str(getattr(source, "provider", "") or "")) if source is not None else None
    if driver is None or not is_request_channel(driver.cls):
        return None
    return source, driver


async def _completions(request: Request, endpoint, caller: str) -> Response:
    from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid  # noqa: PLC0415
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

    try:
        body = await request.json()
    except ValueError:
        return _fail(400, "the body must be JSON")
    if not isinstance(body, dict):
        return _fail(400, "the body must be a JSON object")
    channel = await _channel(endpoint)
    if channel is None:
        return _fail(404, "this endpoint's channel no longer exists", "not_found_error")
    source, driver = channel

    metadata = dict(body.get("metadata") or {}) if isinstance(body.get("metadata"), dict) else {}
    conversation_id = str(metadata.get("conversation_id") or "")
    if not is_valid_entity_id(conversation_id):
        conversation_id = str(mint_uuid())
    metadata["conversation_id"] = conversation_id
    payload = {**body, "metadata": metadata, "caller": caller}

    asked_at = datetime.now(timezone.utc)
    opened = await driver.open(source)
    async with opened:
        events = opened.events_from_request(payload)
    ingested = await driver.ingest_events(source, events)
    ids = ingested.get("ids") or []
    if not ids:
        return _fail(400, "messages must end with a user message that has text")
    item = await SourceItem.get_by_id(ids[-1])
    headers = {"X-Flowpad-Conversation": conversation_id}

    deadline = time.monotonic() + REPLY_DEADLINE_SECONDS
    looks = 0
    while (reply := await SourceItem.find_reply_from_self(source, item, since=asked_at)) is None:
        if time.monotonic() >= deadline:
            return _fail(504, "no reply yet — the message waits in the channel", "no_reply_yet",
                         conversation_id=conversation_id)
        await asyncio.sleep(_REPLY_CHECKS[min(looks, len(_REPLY_CHECKS) - 1)])
        looks += 1
    completion = driver.cls.reply_payload(item, reply, model=_model(endpoint))
    if body.get("stream"):
        return StreamingResponse(_sse(completion), media_type="text/event-stream",
                                 headers={**headers, "Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
    return JSONResponse(completion, headers=headers)


async def _sse(completion: dict):
    """A completion as OpenAI chunks: the role, the whole reply, the stop — the reply is recorded whole."""
    base = {k: completion.get(k) for k in ("id", "created", "model")} | {"object": "chat.completion.chunk"}
    extra = {"flowpad": completion.get("flowpad") or {}}
    content = ((completion.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    for delta, finish in (({"role": "assistant"}, None), ({"content": content}, None), ({}, "stop")):
        chunk = {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}], **extra}
        yield f"data: {json.dumps(chunk)}\n\n"
    yield "data: [DONE]\n\n"


async def _history(endpoint, caller: str, conversation_id: str) -> Response:
    """The caller's conversation so far — its messages on the channel, oldest first."""
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import is_self_address  # noqa: PLC0415

    channel = await _channel(endpoint)
    if channel is None:
        return _fail(404, "this endpoint's channel no longer exists", "not_found_error")
    source, driver = channel
    rows = await SourceItem.get_all({
        "match": {"data_source_id": str(source.id), "thread_key": driver.cls.request_thread(caller, conversation_id)},
        "order_by": [{"created_date": "asc"}, {"id": "asc"}],
    })
    messages = [
        {"role": "assistant" if is_self_address(source, r.author_external_id or "") else "user", "content": r.body or ""}
        for r in rows if (r.body or "").strip()
    ]
    return JSONResponse({"conversation_id": conversation_id, "messages": messages})


__all__ = ["REPLY_DEADLINE_SECONDS", "channel_http"]
