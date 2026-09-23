"""A deployed agent's ``chat`` endpoint — an OpenAI chat API over the agent's turns.

Every agent deployment has one (``AgentBackend``). Whoever may use the endpoint
may chat: the hub authorizes the ``service`` call (a session, a stamped visitor
role) and vouches for the caller (``X-Flowpad-User``); on a desktop the caller is
the person at it. The agent answers on the placement the endpoint belongs to —
the endpoint IS the placement gate — through the one turn engine
(``builtin/agent_serve``), so a chat turn is the same turn a channel message gets.

Surface (paths under ``service_endpoint/<id>/service/``):

* ``POST v1/chat/completions`` — the last ``user`` message is the turn. ``stream``
  answers Server-Sent Events as the agent writes (OpenAI chunk shape; a tool the
  agent uses rides as ``flowpad.tool``); without it, one completion when the turn
  ends. ``metadata.conversation_id`` continues a conversation — omitted, one is
  started — and every answer names it (``flowpad.conversation_id`` and the
  ``X-Flowpad-Conversation`` header).
* ``GET v1/models`` — the one model: this agent.
* ``GET v1/conversations/<id>`` — the conversation so far (``{messages}``).

A conversation is scoped to its caller: the same id from someone else is a
different conversation, so an id is never a key to another person's chat.
"""

from __future__ import annotations

import json
import time
from typing import Any, Optional

from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

_LOCAL_CALLER = "local"


def _fail(status: int, message: str, kind: str = "invalid_request_error", *, answer=None) -> JSONResponse:
    content: dict = {"error": {"message": message, "type": kind}}
    if answer is not None:
        # The turn's own verdict, for a Flowpad-aware client: which process, and
        # whether it is still working (`timed_out`) or merely busy.
        content["flowpad"] = {
            "exit_code": int(answer.exit_code),
            "executor": answer.executor,
            "timed_out": answer.timed_out,
            "busy": answer.busy,
        }
    return JSONResponse(status_code=status, content=content)


async def agent_chat_http(request: Request, endpoint, sub_path: str, caller: Optional[str]) -> Response:
    """Answer one request on a deployed agent's ``chat`` endpoint (``endpoint.backend.type == "agent"``)."""
    path = sub_path.strip("/")
    if path.startswith("v1/"):
        path = path[3:]
    if request.method == "GET" and path == "models":
        return JSONResponse({"object": "list", "data": [_model(endpoint)]})
    placed = await _placed(endpoint)
    if isinstance(placed, Response):
        return placed
    agent, deployment = placed
    who = caller or _LOCAL_CALLER
    if request.method == "GET" and path.startswith("conversations/"):
        return await _history(agent, deployment, endpoint, who, path.partition("/")[2])
    if request.method == "POST" and path == "chat/completions":
        return await _completions(request, agent, deployment, endpoint, who)
    return _fail(404, f"no {request.method} {sub_path} on an agent's chat endpoint")


def _model(endpoint) -> dict:
    return {"id": f"agent-{endpoint.backend.agent_id}", "object": "model", "owned_by": "flowpad"}


async def _placed(endpoint):
    """The agent and the placement this endpoint answers on — which must be THIS machine."""
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    agent = await Agent.get_by_id(endpoint.backend.agent_id)
    if agent is None:
        return _fail(404, "this endpoint's agent no longer exists", "not_found_error")
    try:
        deployment = await Deployment.get_by_typeid(TypeId(endpoint.parent_type_id or ""))
    except (ValueError, IndexError):
        deployment = None
    if deployment is None or not deployment.is_local:
        return _fail(409, "this endpoint's agent answers on another machine", "not_here_error")
    if not agent.enabled_on(deployment.id):
        return _fail(409, "the agent is switched off on this placement", "disabled_error")
    return agent, deployment


def _session(endpoint, caller: str, conversation_id: str) -> str:
    """The turn engine's session: this endpoint, this caller, this conversation."""
    return f"chat:{endpoint.id}:{caller}:{conversation_id}"


def _text_of(content: Any) -> str:
    """A message's text — a string, or the text parts of a content list."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(p.get("text") or "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


async def _completions(request: Request, agent, deployment, endpoint, caller: str) -> Response:
    from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid  # noqa: PLC0415
    from flow_sdk.builtin.agent_serve import Turn, TurnEngine  # noqa: PLC0415

    try:
        body = await request.json()
    except ValueError:
        return _fail(400, "the body must be JSON")
    messages = body.get("messages") if isinstance(body, dict) else None
    user = next((m for m in reversed(messages or []) if isinstance(m, dict) and m.get("role") == "user"), None)
    text = _text_of(user.get("content")).strip() if user else ""
    if not text:
        return _fail(400, "messages must end with a user message that has text")
    metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
    conversation_id = str(metadata.get("conversation_id") or "")
    if not is_valid_entity_id(conversation_id):
        conversation_id = str(mint_uuid())
    turn = Turn(
        session=_session(endpoint, caller, conversation_id),
        key=str(metadata.get("message_id") or mint_uuid()),
        body=text,
        name=" · ".join(p for p in (agent.name, "chat", caller) if p),
        context={"chat": {"endpoint_id": endpoint.id, "caller": caller, "conversation_id": conversation_id}},
    )
    engine = TurnEngine(agent, deployment)
    model = _model(endpoint)["id"]
    headers = {"X-Flowpad-Conversation": conversation_id}
    if body.get("stream"):
        return StreamingResponse(
            _sse(engine.run_stream(turn), model, conversation_id),
            media_type="text/event-stream",
            headers={**headers, "Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    outcome = await engine.run(turn)
    if not outcome.ok:
        # An OpenAI client raises on a non-2xx and never reads our exit code, so
        # here — unlike Flowpad's own edges — a turn that was not answered is a
        # protocol error. The answer rides under `flowpad` for a client that does.
        status, kind = _status_of(outcome)
        return _fail(status, outcome.detail or "the agent did not answer", kind, answer=outcome)
    return JSONResponse(
        {
            "id": f"chatcmpl-{turn.key}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [
                {"index": 0, "message": {"role": "assistant", "content": outcome.text}, "finish_reason": "stop"}
            ],
            "flowpad": _flowpad(conversation_id, outcome),
        },
        headers=headers,
    )


def _flowpad(conversation_id: str, answer) -> dict:
    """What a Flowpad-aware client reads beside the OpenAI shape: the turn's verdict
    and the process that ran it, so it can continue the same session."""
    return {
        "conversation_id": conversation_id,
        "exit_code": int(answer.exit_code),
        "executor": answer.executor,
        "timed_out": answer.timed_out,
    }


def _status_of(answer) -> "tuple[int, str]":
    """A turn that was not answered, as the OpenAI protocol spells failure.

    409 only for ``busy`` — another turn holds the conversation, try again.
    REFUSED is the agent disabled here (403), NOT_FOUND the agent gone (404).
    Every other NOT_YET — not taken, errored, out of time — is the agent behind
    this endpoint failing its turn: 502, never a 200 with empty content.
    """
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode  # noqa: PLC0415

    if answer.busy:
        return 409, "turn_busy"
    if answer.exit_code is ExitCode.REFUSED:
        return 403, "agent_disabled"
    if answer.exit_code is ExitCode.NOT_FOUND:
        return 404, "agent_not_found"
    if answer.timed_out:
        return 502, "turn_timed_out"
    return 502, "turn_not_answered"


async def _sse(events, model: str, conversation_id: str):
    """The turn as OpenAI chunks: each message the agent writes is a content delta."""
    created = int(time.time())
    chunk_id = f"chatcmpl-{conversation_id}-{created}"
    wrote = False

    def chunk(delta: dict, finish: Optional[str] = None, extra: Optional[dict] = None) -> str:
        payload = {
            "id": chunk_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            "flowpad": {"conversation_id": conversation_id, **(extra or {})},
        }
        return f"data: {json.dumps(payload)}\n\n"

    yield chunk({"role": "assistant"})
    async for event in events:
        if event.kind == "text":
            yield chunk({"content": ("\n\n" if wrote else "") + event.text})
            wrote = True
        elif event.kind == "tool":
            yield chunk({}, extra={"tool": event.name})
        elif event.kind == "done":
            answer = event.answer
            if answer is not None and not answer.ok:
                _status, kind = _status_of(answer)
                error = {"message": answer.detail or "the agent did not answer", "type": kind}
                yield f"data: {json.dumps({'error': error, 'flowpad': _flowpad(conversation_id, answer)})}\n\n"
                break
            if not wrote and event.text:
                # Answered from the record (a redelivery), or a turn whose text only the end reveals.
                yield chunk({"content": event.text})
            extra = _flowpad(conversation_id, answer) if answer is not None else {}
            yield chunk({}, finish="stop", extra={k: v for k, v in extra.items() if k != "conversation_id"})
    yield "data: [DONE]\n\n"


async def _history(agent, deployment, endpoint, caller: str, conversation_id: str) -> Response:
    """The conversation so far: its user and assistant messages, oldest first."""
    from flow_sdk.builtin.agent_serve import TurnEngine, transcript_entries  # noqa: PLC0415

    ap = await TurnEngine(agent, deployment).find_process(_session(endpoint, caller, conversation_id))
    messages: list[dict] = []
    for entry in transcript_entries(ap) if ap is not None else []:
        kind = getattr(getattr(entry, "kind", None), "value", "")
        text = str(getattr(entry, "text", "") or "").strip()
        if kind in ("user_message", "assistant_message") and text:
            messages.append({"role": "user" if kind == "user_message" else "assistant", "content": text})
    return JSONResponse({"conversation_id": conversation_id, "messages": messages})


__all__ = ["agent_chat_http"]
