"""Live hub, through a desktop: the desktop's own multi-step wrappers (they reach the hub through
HubProxy) do their job against the real hub.

    uv run pytest -p flowpad.hub.tests.conftest -p hub_passthrough_plugin tests/hub_passthrough/live_call_sites.py
"""

from __future__ import annotations

import httpx

import hub_passthrough_plugin as hp


async def _desktop(token: str) -> httpx.AsyncClient:
    url = await hp._desktop_for(token)
    return httpx.AsyncClient(base_url=url, timeout=60)


async def _hub_conversation(service, token: str, title: str, invite: str | None = None) -> str:
    async with hp._state["original"](service, headers={"Authorization": f"Bearer {token}"}) as h:
        r = await h.post("/api/v1/graph/conversation", json={"title": title})
        assert r.status_code == 200, r.text
        cid = r.json()["data"]["id"]
        if invite:
            r = await h.post(
                f"/api/v1/graph/conversation/{cid}/members",
                json={"recipient_email": invite, "invitation_targets": [{"typeid": f"conversation-{cid}", "role": "member"}]},
            )
            assert r.status_code < 300, r.text
    return cid


async def test_conversation_list_brings_the_hubs_conversation_into_the_desktop(service, alice_token):
    cid = await _hub_conversation(service, alice_token, "call-site list")
    async with await _desktop(alice_token) as d:
        r = await d.post("/api/v1/graph/conversation-list", json={})
        assert r.status_code == 200 and r.json()["status"] == "SUCCESS", r.text
        ids = {c.get("id") for c in r.json()["data"].get("conversations") or []}
        assert cid in ids, ids
        local = await d.get(f"/api/v1/graph/conversation/{cid}")
    assert local.status_code == 200 and local.json()["data"]["title"] == "call-site list"


async def test_conversation_sync_answers(service, alice_token):
    async with await _desktop(alice_token) as d:
        r = await d.post("/api/v1/graph/conversation-sync", json={})
    assert r.status_code == 200 and r.json()["status"] == "SUCCESS", r.text


async def test_helpdesk_tickets_list_answers(service, alice_token):
    async with await _desktop(alice_token) as d:
        r = await d.post("/api/v1/graph/helpdesk-tickets-list", json={})
    # Alice runs no help desk: the hub refuses, and the desktop says so with the hub's own status.
    body = r.json()
    if body["status"] == "FAIL":
        assert r.status_code == body["data"]["hub_status"] == 403 and body["data"]["hub_code"] == "target_not_found", r.text
    else:
        assert r.status_code == 200, r.text


async def test_invitation_decline_reaches_the_hub(service, alice_token, bob_token, bob_user):
    await _hub_conversation(service, alice_token, "call-site decline", invite=bob_user.email)
    async with hp._state["original"](service, headers={"Authorization": f"Bearer {bob_token}"}) as h:
        pending = (await h.get("/api/v1/graph/invitation/pending")).json()["data"]
    rows = pending if isinstance(pending, list) else (pending or {}).get("invitations") or []
    assert rows, pending
    inv = rows[0].get("id")
    async with await _desktop(bob_token) as d:
        r = await d.post("/api/v1/graph/invitation-decline", json={"invitation_id": inv})
    assert r.status_code == 200 and r.json()["status"] == "SUCCESS", r.text
    async with hp._state["original"](service, headers={"Authorization": f"Bearer {bob_token}"}) as h:
        after = (await h.get("/api/v1/graph/invitation/pending")).json()["data"]
    after_rows = after if isinstance(after, list) else (after or {}).get("invitations") or []
    assert inv not in {x.get("id") for x in after_rows}


async def test_invitation_accept_joins_on_the_hub_and_lands_the_conversation(service, alice_token, bob_token, bob_user):
    cid = await _hub_conversation(service, alice_token, "call-site accept", invite=bob_user.email)
    bob = {"Authorization": f"Bearer {bob_token}"}
    async with hp._state["original"](service, headers=bob) as h:
        pending = (await h.get("/api/v1/graph/invitation/pending")).json()["data"]
    inv = next(row["id"] for row in pending if cid in str(row))
    async with await _desktop(bob_token) as d:
        r = await d.post("/api/v1/graph/invitation-accept", json={"invitation_id": inv})
        assert r.status_code == 200 and r.json()["status"] == "SUCCESS", r.text
        local = await d.get(f"/api/v1/graph/conversation/{cid}")
    assert local.status_code == 200 and local.json()["data"]["title"] == "call-site accept", local.text
    async with hp._state["original"](service, headers=bob) as h:
        hub_row = await h.get(f"/api/v1/graph/conversation/{cid}")
    assert hub_row.status_code == 200, hub_row.text  # bob is a member on the hub now
