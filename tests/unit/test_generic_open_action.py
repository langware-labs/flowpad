"""One ``GET <type>/<id>/open`` deep-link route for every type (generic-open U3).

The per-type handlers (``flow_message.open``, ``notification.open``) become
``resolve_open`` overrides on their classes behind a single generic ``open``; a
type outside ``OPENABLE_TYPES`` is refused. The message and notification links
are characterized here — their redirects must be exactly what the per-type
handlers produced.

Real request middleware + graph dispatcher; the hub is stubbed at the module
names the handlers call.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import pytest

from flow_sdk.actions.action_registry import action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


async def _call_local(method: str, path: str):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    import flow_sdk.app.actions  # noqa: F401 — side-effect registration
    from flow_sdk.server.middleware.request_transaction_middleware import RequestTransactionMiddleware
    from flow_sdk.server.routes import graph_router

    app = FastAPI()
    app.add_middleware(RequestTransactionMiddleware)
    app.include_router(graph_router, prefix="/api/v1/graph")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://localhost") as client:
        return await client.request(method, f"/api/v1/graph/{path}")


def _redirect_params(resp) -> dict[str, list[str]]:
    assert resp.status_code == 200, resp.text
    match = re.search(r'url=(http://localhost:\d+/dock/home\?[^"]+)"', resp.text)
    assert match, f"no UI redirect in: {resp.text[:300]}"
    return parse_qs(urlsplit(match.group(1)).query)


@pytest.fixture
def message_hub(monkeypatch):
    """The hub a message deep link talks to: the message, its conversation, no
    further messages to sync, and a join that succeeds."""
    from flow_sdk.app.actions import flow_message_action

    fid, cid = str(uuid4()), str(uuid4())

    async def _hub_get(entity_type, entity_id=None, *args, scope=None, **kwargs):
        et = getattr(entity_type, "value", entity_type)
        if et == BuiltinEntityType.FLOW_MESSAGE.value and entity_id == fid:
            return {
                "id": fid,
                "text": "hi",
                "shared_context_entities": [f"conversation-{cid}"],
                "metadata": {"sender_name": "Dana", "task_title": "Plan"},
            }
        if et == BuiltinEntityType.CONVERSATION.value and entity_id == cid:
            return {"id": cid, "title": "thread"}
        return [] if scope else None

    async def _hub_post(*args, **kwargs):
        return {}

    monkeypatch.setattr(flow_message_action, "hub_get", _hub_get)
    monkeypatch.setattr(flow_message_action, "hub_post", _hub_post)
    return fid, cid


@pytest.mark.asyncio
async def test_a_message_link_redirects_into_its_conversation(message_hub):
    fid, cid = message_hub

    params = _redirect_params(await _call_local("GET", f"flow_message/{fid}/open"))

    assert params == {
        "action": ["open"],
        "fm": [fid],
        "conversation_id": [cid],
        "sender_name": ["Dana"],
        "title": ["Plan"],
    }


@pytest.mark.asyncio
async def test_a_notification_link_redirects_with_its_task(monkeypatch):
    from flow_sdk.app.actions import notification_action

    nid = str(uuid4())

    async def _hub_get(entity_type, entity_id=None, *args, **kwargs):
        return {"metadata": {"task_id": "t-1", "sender_name": "Dana", "task_title": "Fix it"}}

    monkeypatch.setattr(notification_action, "hub_get", _hub_get)

    params = _redirect_params(await _call_local("GET", f"notification/{nid}/open"))

    assert params == {
        "action": ["open"],
        "fm": [nid],
        "task_id": ["t-1"],
        "sender_name": ["Dana"],
        "title": ["Fix it"],
    }


@pytest.mark.asyncio
async def test_a_type_with_no_resolver_cannot_be_opened_from_a_link():
    resp = await _call_local("GET", f"comment/{uuid4()}/open")

    assert resp.status_code == 400, resp.text
    assert "can't be opened from a link" in resp.text


def test_one_generic_open_replaces_the_per_type_ones():
    import flow_sdk.app.actions  # noqa: F401

    for entity_type in ("flow_message", "notification"):
        resolved = action.get_by_name("open", entity_type)
        assert resolved is not None and resolved.action_name == "open", entity_type
    # A type's own open action is untouched (and still wins for that type).
    assert action.get_by_name("open", "agentic_process").action_name == "agentic_process.open"
