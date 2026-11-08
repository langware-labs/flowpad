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
  ``stream`` answers Server-Sent Events (OpenAI chunk shape) at once: the role chunk, an SSE comment
  every ``KEEP_ALIVE_SECONDS`` while the turn runs, then the reply once it is recorded. A turn outlasts
  any idle-read timeout between the caller and this box (the desktop's hub proxy gives up after 30s of
  silence), so a stream is never silent — and is bounded by how long an agent turn may run
  (``AGENT_TIMEOUT``), not by ``REPLY_DEADLINE_SECONDS``.
* ``GET v1/conversations/<id>`` — the caller's conversation so far (``{messages}``), from the channel.
* ``GET v1/models`` — the one model: this endpoint.

Without ``stream``, no reply within ``REPLY_DEADLINE_SECONDS`` is a 504 naming the conversation — the message stays in
the channel and is answered when its loop gets to it.
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import AsyncIterator, Optional

from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

from flow_sdk.schema.data_spec.compute_op_spec import AGENT_TIMEOUT

#: How long one non-streamed request waits for its reply — the request/response contract, not a retry
#: budget. A streamed request waits as long as an agent turn may run (``AGENT_TIMEOUT``).
REPLY_DEADLINE_SECONDS = 60.0
#: How often a stream says it is alive while the turn runs — well inside any proxy's idle-read timeout.
KEEP_ALIVE_SECONDS = 5.0
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
    try:
        body = await request.json()
    except ValueError:
        return _fail(400, "the body must be JSON")
    if not isinstance(body, dict):
        return _fail(400, "the body must be a JSON object")
    if not body.get("stream"):
        outcome = await ask(endpoint, caller, body)
        if isinstance(outcome, Response):
            return outcome
        completion, conversation_id = outcome
        return JSONResponse(completion, headers={"X-Flowpad-Conversation": conversation_id})
    asked = await _post(endpoint, caller, body)
    if isinstance(asked, Response):
        return asked
    return StreamingResponse(_sse(endpoint, asked), media_type="text/event-stream",
                             headers={"X-Flowpad-Conversation": asked.conversation_id,
                                      "Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class _Asked:
    """A message posted on an endpoint's channel, awaiting the reply its loop records."""

    def __init__(self, source, driver, item, asked_at: datetime, conversation_id: str):
        self.source, self.driver, self.item = source, driver, item
        self.asked_at, self.conversation_id = asked_at, conversation_id


async def ask(endpoint, caller: str, body: dict):
    """One request on the endpoint's channel, and the reply its answering loop records:
    ``(completion, conversation_id)``, or the failure as a ``Response`` (a 504 names the conversation —
    the message stays in the channel and is answered when its loop gets to it).

    The route's whole contract, callable without HTTP: an agent's ``ask`` action uses it for the hub
    that placed the agent here (``Agent.ask_action``)."""
    asked = await _post(endpoint, caller, body)
    if isinstance(asked, Response):
        return asked
    async for outcome in _await_reply(endpoint, asked, REPLY_DEADLINE_SECONDS, wake_every=None):
        if outcome is not None:
            break
    if isinstance(outcome, Response):
        return outcome
    return asked.driver.cls.reply_payload(asked.item, outcome, model=_model(endpoint)), asked.conversation_id


async def _post(endpoint, caller: str, body: dict):
    """Put *body*'s message on the endpoint's channel: an :class:`_Asked`, or the failure as a ``Response``."""
    from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid  # noqa: PLC0415
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

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
    return _Asked(source, driver, await SourceItem.get_by_id(ids[-1]), asked_at, conversation_id)


async def _await_reply(endpoint, asked: _Asked, within: float, *, wake_every: Optional[float]) -> AsyncIterator:
    """Wait up to *within* seconds for *asked*'s reply. Yields ``None`` every *wake_every* seconds while
    waiting (so a stream can say it is alive), then once: the reply row, or the failure as a ``Response``."""
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

    deadline = time.monotonic() + within
    woke = time.monotonic()
    looks = 0
    while (reply := await SourceItem.find_reply_from_self(asked.source, asked.item, since=asked.asked_at)) is None:
        if await _turn_failed(endpoint, asked.item):
            # The loop never runs a failed turn again (it may have half-acted); waiting would only end
            # in a 504, and asking again in another. Said now, so the caller can tell the person.
            yield _fail(422, "the agent could not answer this message", "turn_failed",
                        conversation_id=asked.conversation_id)
            return
        if time.monotonic() >= deadline:
            hint = "" if wake_every is not None else " (ask with stream:true to wait for a long turn)"
            yield _fail(504, f"no reply yet — the message waits in the channel{hint}", "no_reply_yet",
                        conversation_id=asked.conversation_id)
            return
        if wake_every is not None and time.monotonic() - woke >= wake_every:
            woke = time.monotonic()
            yield None
        await asyncio.sleep(_REPLY_CHECKS[min(looks, len(_REPLY_CHECKS) - 1)])
        looks += 1
    yield reply


async def _turn_failed(endpoint, item) -> bool:
    """Whether the loop answering *endpoint* ended *item*'s turn in error — its record on the placement's
    session processes, the one place the loop writes it."""
    from flow_sdk.builtin.agent_serve import FAILED, turn_key, turns_of  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    parent = str(getattr(endpoint, "parent_type_id", "") or "")
    if not parent.startswith("deployment-"):
        return False
    key = turn_key(item)
    processes = await AgenticProcess.get_all({"deployment_id": TypeId(parent).id}) or []
    return any((turns_of(p).get(key) or {}).get("status") == FAILED for p in processes)


async def _sse(endpoint, asked: _Asked):
    """The turn as OpenAI chunks: the role at once, a keep-alive comment while the turn runs, then the
    whole reply and the stop (the reply is recorded whole) — or the failure as an ``error`` event."""
    opening = asked.driver.cls.reply_payload(asked.item, None, model=_model(endpoint))
    base = {k: opening.get(k) for k in ("id", "created", "model")} | {"object": "chat.completion.chunk"}
    extra = {"flowpad": opening.get("flowpad") or {}}

    def chunk(delta: dict, finish: Optional[str] = None) -> str:
        return f"data: {json.dumps({**base, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}], **extra})}\n\n"

    yield chunk({"role": "assistant"})
    async for outcome in _await_reply(endpoint, asked, AGENT_TIMEOUT, wake_every=KEEP_ALIVE_SECONDS):
        if outcome is None:
            yield ": keep-alive\n\n"
        elif isinstance(outcome, Response):
            yield f"data: {outcome.body.decode()}\n\n"
        else:
            completion = asked.driver.cls.reply_payload(asked.item, outcome, model=_model(endpoint))
            yield chunk({"content": ((completion.get("choices") or [{}])[0].get("message") or {}).get("content") or ""})
            yield chunk({}, "stop")
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


__all__ = ["KEEP_ALIVE_SECONDS", "REPLY_DEADLINE_SECONDS", "ask", "channel_http"]
