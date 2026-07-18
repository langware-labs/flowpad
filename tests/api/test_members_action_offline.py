"""The generic ``members`` action is hub-driven.

Reads (GET) fall back to the local cache; MUTATIONS (POST/PUT/DELETE) must FAIL
LOUDLY (409) when they can't reach the hub instead of the old fake-success — the
test client is not cloud-logged-in and the entity is local-only, so no call
reflects. This is the backstop behind the UI's disable-when-unavailable gate.
"""
import pytest


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_members_get_returns_cache_but_mutations_409_offline(bootstrapped_client):
    # A local-only entity (bookmark); the members action is types="all".
    resp = await bootstrapped_client.post(
        "/api/v1/graph/bookmark",
        json={"title": "roster host", "bookmark_type": "note", "source": "members-test"},
    )
    assert resp.status_code == 200, resp.text
    bid = resp.json()["data"]["id"]

    # GET is a stale-tolerant read → 200 with the cached (empty) roster, never 409.
    resp = await bootstrapped_client.get(f"/api/v1/graph/bookmark/{bid}/members")
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"] == []

    # Every mutation fails loudly (409) — no local membership store, nothing reflected.
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/bookmark/{bid}/members",
        json={"recipient_email": "x@example.com", "invitation_targets": []},
    )
    assert resp.status_code == 409, resp.text

    resp = await bootstrapped_client.put(
        f"/api/v1/graph/bookmark/{bid}/members",
        json={"user_id": "u", "role": "member"},
    )
    assert resp.status_code == 409, resp.text

    resp = await bootstrapped_client.request(
        "DELETE",
        f"/api/v1/graph/bookmark/{bid}/members",
        json={"user_id": "u"},
    )
    assert resp.status_code == 409, resp.text
