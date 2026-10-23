"""The routing rule, over HTTP and WS: who answers, and what the local row becomes.

Real desktop server + real echo hub + real local rows (the test SQLite DB).
"""

from __future__ import annotations

import asyncio
import json
import uuid

import httpx
import pytest
import websockets

REFLECT = {"Hub-Reflect": "true"}


async def _conversation(remote: bool, **fields):
    from flow_sdk.builtin.conversation import Conversation

    conv = Conversation(id=str(uuid.uuid4()), title=fields.pop("title", "local title"), **fields)
    conv.remote = remote
    await conv.save()
    return conv


async def _reload(conv):
    from flow_sdk.builtin.conversation import Conversation

    return await Conversation.get_by_id(conv.id)


async def _http(desktop, method, path, **kw):
    async with httpx.AsyncClient(base_url=desktop, timeout=20) as c:
        return await c.request(method, f"/api/v1/graph/{path}", **kw)


async def _ws(desktop, method, *, target=None, action=None, sub_path=None, body=None, query=None, hub_reflect=True,
              direct_resource_type=None):  # fmt: skip
    """One ``rest_api_msg`` over the desktop's real WS endpoint, shaped like the TS SDK's."""
    url = desktop.replace("http://", "ws://") + f"/api/v1/connect/ws/{uuid.uuid4()}"
    async with websockets.connect(url) as ws:
        await ws.recv()  # connection confirmation
        mid = str(uuid.uuid4())
        await ws.send(
            json.dumps(
                {
                    "message_type": "rest_api_msg",
                    "message_id": mid,
                    "method": method,
                    "scope": [],
                    "direct_resource_type": direct_resource_type,
                    "target_typeid": target,
                    "action": action,
                    "sub_path": sub_path,
                    "query_params": query,
                    "body": body,
                    "hub_reflect": hub_reflect,
                }
            )
        )
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), 20))
            if msg.get("response_message_id") == mid:
                return msg["content"]


# ── who answers ──────────────────────────────────────────────────────────────────


async def test_no_reflect_header_stays_local(desktop, echo_hub):
    conv = await _conversation(remote=True)
    r = await _http(desktop, "GET", f"conversation/{conv.id}")
    assert r.status_code == 200 and r.json()["data"]["id"] == conv.id
    assert echo_hub.received == []


async def test_a_local_only_row_stays_local_even_when_asked(desktop, echo_hub):
    conv = await _conversation(remote=False)
    r = await _http(desktop, "GET", f"conversation/{conv.id}", headers=REFLECT)
    assert r.status_code == 200 and r.json()["data"]["id"] == conv.id
    assert echo_hub.received == []


async def test_a_remote_row_is_answered_by_the_hub(desktop, echo_hub):
    conv = await _conversation(remote=True)
    r = await _http(desktop, "POST", f"conversation/{conv.id}/close", json={}, headers=REFLECT)
    assert r.status_code == 200
    assert echo_hub.received[0].raw_path == f"/api/v1/graph/conversation/{conv.id}/close"


async def test_a_desktop_action_name_does_not_shadow_the_hubs(desktop, echo_hub):
    # Asked of the hub, ``members/accept`` is the hub's — not the desktop's ``members`` handler.
    r = await _http(desktop, "GET", "members/accept", params={"invitation-id": "I1"}, headers=REFLECT)
    assert r.status_code == 200
    assert [(x.method, x.raw_path, x.query) for x in echo_hub.received] == [
        ("GET", "/api/v1/graph/members/accept", "invitation-id=I1")
    ]


async def test_a_desktop_action_without_the_flag_runs_locally(desktop, echo_hub):
    r = await _http(desktop, "POST", "conversation-list", json={})
    assert r.status_code != 404
    assert echo_hub.received == []


async def test_hub_only_type_without_header_still_goes_to_the_hub(desktop, echo_hub):
    r = await _http(desktop, "GET", "llm_endpoint")
    assert r.status_code == 200 and echo_hub.received[0].raw_path == "/api/v1/graph/llm_endpoint"


async def test_hub_only_type_signed_out_is_409_and_nothing_leaves(desktop_server, echo_hub, sod_env):
    r = await _http(desktop_server.url, "GET", "llm_endpoint")
    assert r.status_code == 409 and r.json()["status"] == "FAIL"
    assert echo_hub.received == []


async def test_signed_out_reflect_runs_locally(desktop_server, echo_hub, sod_env):
    conv = await _conversation(remote=True)
    r = await _http(desktop_server.url, "GET", f"conversation/{conv.id}", headers=REFLECT)
    assert r.status_code == 200 and r.json()["data"]["id"] == conv.id
    assert echo_hub.received == []


async def test_local_privacy_mode_sends_nothing(desktop, echo_hub, monkeypatch):
    import flow_sdk.cloud_client.transport.hub_http as hub_http
    import flow_sdk.instance_settings.privacy_mode as privacy
    import flow_sdk.server.routes._hub_reflect as reflect

    monkeypatch.setattr(privacy, "is_local_mode", lambda: True)
    monkeypatch.setattr(reflect, "is_local_mode", lambda: True)
    monkeypatch.setattr(hub_http, "hub_base_url", lambda: None)
    conv = await _conversation(remote=True)
    r = await _http(desktop, "GET", f"conversation/{conv.id}", headers=REFLECT)
    assert r.status_code == 200
    r = await _http(desktop, "GET", "llm_endpoint")
    assert r.status_code == 409
    assert echo_hub.received == []


# ── bare update: body rules ──────────────────────────────────────────────────────


async def test_an_update_of_only_local_fields_never_leaves(desktop, echo_hub):
    conv = await _conversation(remote=True)
    r = await _http(desktop, "PUT", f"conversation/{conv.id}", json={"is_unread": True}, headers=REFLECT)
    assert r.status_code == 200, r.text
    assert echo_hub.received == []


async def test_archive_is_per_user_and_never_leaves(desktop, echo_hub):
    conv = await _conversation(remote=True)
    await _http(desktop, "PUT", f"conversation/{conv.id}", json={"archived_at": "2026-10-01T00:00:00Z"}, headers=REFLECT)
    assert echo_hub.received == []


async def test_a_shared_update_is_forwarded_as_sent(desktop, echo_hub):
    conv = await _conversation(remote=True)
    body = {"title": "renamed", "git_sharing_enabled": True}
    r = await _http(desktop, "PUT", f"conversation/{conv.id}", json=body, headers=REFLECT)
    assert r.status_code == 200
    rec = echo_hub.received[0]
    assert rec.method == "PUT" and json.loads(rec.body) == body


# ── mirror: the hub's answer folded into the local row ───────────────────────────


async def test_a_hub_answer_about_the_row_updates_its_hub_fields_only(desktop, echo_hub):
    conv = await _conversation(remote=True, title="before")
    from flow_sdk.builtin.conversation import Conversation

    row = await Conversation.get_by_id(conv.id)
    row.address = ["me@local.test"]
    await row.save()
    hub_row = {"id": conv.id, "type": "conversation", "title": "after", "status": "closed", "address": ["hub@x"]}
    r = await _http(desktop, "PUT", f"conversation/{conv.id}", json={"title": "after"},
                    headers={**REFLECT, "x-echo-mode": "answer", "x-echo-answer": json.dumps(hub_row)})  # fmt: skip
    assert r.status_code == 200 and r.json()["data"] == hub_row  # verbatim answer
    local = await _reload(conv)
    assert local.title == "after"
    assert str(local.status) in ("closed", "ConversationStatus.CLOSED")
    assert local.address == ["me@local.test"]  # PRIVATE: never taken from the hub


async def test_a_list_answer_updates_rows_held_here_and_adds_none(desktop, echo_hub):
    held = await _conversation(remote=True, title="old")
    stranger = str(uuid.uuid4())
    rows = [{"id": held.id, "type": "conversation", "title": "new"}, {"id": stranger, "type": "conversation", "title": "x"}]
    r = await _http(desktop, "GET", "conversation",
                    headers={**REFLECT, "x-echo-mode": "answer", "x-echo-answer": json.dumps(rows)})  # fmt: skip
    assert r.status_code == 200 and r.json()["data"] == rows
    from flow_sdk.builtin.conversation import Conversation

    assert (await _reload(held)).title == "new"
    assert await Conversation.get_by_id(stranger) is None


async def test_a_refusal_changes_nothing_locally(desktop, echo_hub):
    conv = await _conversation(remote=True, title="keep")
    r = await _http(desktop, "PUT", f"conversation/{conv.id}", json={"title": "nope"},
                    headers={**REFLECT, "x-echo-status": "403"})  # fmt: skip
    assert r.status_code == 403
    assert (await _reload(conv)).title == "keep"


# ── offline ──────────────────────────────────────────────────────────────────────


@pytest.fixture
def hub_down(echo_hub, monkeypatch):
    import flow_sdk.cloud_client.transport.hub_http as hub_http
    from flow_sdk.config import default_service_config

    monkeypatch.setattr(default_service_config, "flowpad_hub_url", "http://127.0.0.1:9")  # nothing listens
    yield
    # The failed calls marked the hub unreachable; the next good call would start an outbox
    # drain of whatever other tests left queued. Not this suite's business — reset the mark.
    hub_http._hub_unreachable = False


async def test_offline_read_answers_from_the_local_copy(desktop, hub_down):
    conv = await _conversation(remote=True, title="cached")
    r = await _http(desktop, "GET", f"conversation/{conv.id}", headers=REFLECT)
    assert r.status_code == 200 and r.json()["data"]["title"] == "cached"


async def test_offline_write_fails_loudly_and_changes_nothing(desktop, hub_down):
    conv = await _conversation(remote=True, title="cached")
    r = await _http(desktop, "PUT", f"conversation/{conv.id}", json={"title": "x"}, headers=REFLECT)
    assert r.status_code == 502 and r.json()["status"] == "FAIL"
    assert (await _reload(conv)).title == "cached"
    r = await _http(desktop, "POST", f"conversation/{conv.id}/pickup", json={}, headers=REFLECT)
    assert r.status_code == 502


async def test_expired_login_is_401_and_nothing_leaves(desktop, echo_hub):
    from flow_sdk.cli.auth.credentials import UserHubCredentials, save_credentials
    from tests.unit.hub_proxy.conftest import ECHO_TOKEN, ECHO_USER

    save_credentials(UserHubCredentials(api_key=ECHO_TOKEN, expires_at=1.0, user=ECHO_USER))
    r = await _http(desktop, "POST", f"conversation/{uuid.uuid4()}/pickup", json={}, headers=REFLECT)
    assert r.status_code == 401
    assert echo_hub.received == []


# ── WS parity: the same calls over the socket ───────────────────────────────────


async def test_ws_reflected_action_reaches_the_hub_with_its_body(desktop, echo_hub):
    cid = str(uuid.uuid4())
    content = await _ws(desktop, "POST", target={"type": "conversation", "id": cid}, action="add_message",
                        body={"text": "hi", "n": 1})  # fmt: skip
    assert content["status"] == "SUCCESS"
    # A WS frame carries no HTTP header, so no test tag: find the request by its (unique) path.
    [rec] = [r for r in echo_hub.all_received if r.raw_path == f"/api/v1/graph/conversation/{cid}/add_message"]
    assert rec.method == "POST"
    assert json.loads(rec.body) == {"text": "hi", "n": 1}


async def test_ws_query_and_sub_path_reach_the_hub(desktop, echo_hub):
    cid = str(uuid.uuid4())
    await _ws(desktop, "GET", target={"type": "conversation", "id": cid}, action="members", sub_path="link",
              query={"link-id": "L1"})  # fmt: skip
    [rec] = [r for r in echo_hub.all_received if r.raw_path == f"/api/v1/graph/conversation/{cid}/members/link"]
    assert rec.query == "link-id=L1"


async def test_ws_hub_refusal_comes_back_as_fail(desktop, echo_hub):
    # A WS frame carries no HTTP status: the hub's refusal arrives as the FAIL envelope.
    content = await _ws(desktop, "GET", direct_resource_type="llm_endpoint", hub_reflect=False)
    assert content["status"] == "SUCCESS"  # hub-only: forwarded without the opt-in
    assert any(r.raw_path == "/api/v1/graph/llm_endpoint" for r in echo_hub.all_received)


async def test_ws_local_row_stays_local(desktop, echo_hub):
    conv = await _conversation(remote=False)
    content = await _ws(desktop, "GET", target={"type": "conversation", "id": conv.id})
    assert content["status"] == "SUCCESS" and content["data"]["id"] == conv.id
    assert not [r for r in echo_hub.all_received if conv.id in r.raw_path]  # WS carries no tag: match the id


async def test_ws_offline_write_fails_loudly(desktop, hub_down):
    conv = await _conversation(remote=True)
    content = await _ws(desktop, "PUT", target={"type": "conversation", "id": conv.id}, body={"title": "x"})
    assert content["status"] == "FAIL"
