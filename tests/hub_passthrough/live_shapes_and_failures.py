"""Live hub, through a desktop: the call sites and failure modes the hub suite does not reach.

    uv run pytest -p flowpad.hub.tests.conftest -p hub_passthrough_plugin <this file>
"""

from __future__ import annotations

import hub_passthrough_plugin as hp


async def test_a_ticket_closes_and_reopens_through_a_desktop(service, alice_token):
    headers = {"Authorization": f"Bearer {alice_token}"}
    async with hp._passthrough_client(service, headers=headers) as c:
        r = await c.post("/api/v1/graph/conversation", json={"title": "proxy close/reopen"})
        assert r.status_code == 200, r.text
        cid = r.json()["data"]["id"]
        closed = await c.post(f"/api/v1/graph/conversation/{cid}/close", json={})
        assert closed.status_code == 200, closed.text
        reopened = await c.post(f"/api/v1/graph/conversation/{cid}/reopen", json={})
        assert reopened.status_code == 200, reopened.text
        row = await c.get(f"/api/v1/graph/conversation/{cid}")
    async with hp._state["original"](service, headers=headers) as d:
        direct = await d.get(f"/api/v1/graph/conversation/{cid}")
    assert row.status_code == direct.status_code == 200
    assert row.json()["data"].get("status") == direct.json()["data"].get("status")


async def test_another_users_row_is_refused_the_same_through_a_desktop(service, alice_token, bob_token):
    async with hp._passthrough_client(service, headers={"Authorization": f"Bearer {alice_token}"}) as a:
        cid = (await a.post("/api/v1/graph/conversation", json={"title": "alice only"})).json()["data"]["id"]
    bob = {"Authorization": f"Bearer {bob_token}"}
    async with hp._passthrough_client(service, headers=bob) as p, hp._state["original"](service, headers=bob) as d:
        for method, path in (("GET", f"/api/v1/graph/conversation/{cid}"), ("PUT", f"/api/v1/graph/conversation/{cid}")):
            kw = {"json": {"title": "bob was here"}} if method == "PUT" else {}
            pr, dr = await p.request(method, path, **kw), await d.request(method, path, **kw)
            assert pr.status_code == dr.status_code and pr.status_code >= 400, (method, pr.text, dr.text)
    async with hp._state["original"](service, headers={"Authorization": f"Bearer {alice_token}"}) as a:
        assert (await a.get(f"/api/v1/graph/conversation/{cid}")).json()["data"]["title"] == "alice only"


async def test_a_stale_login_is_signed_out_and_then_stays_local(alice_token):
    import httpx

    url = await hp._desktop_for(alice_token, ("--then-token", "not-a-token-the-hub-knows"))
    reflect = {"hub-reflect": "true"}
    async with httpx.AsyncClient(base_url=url, timeout=60) as c:
        first = await c.get("/api/v1/graph/conversation", headers=reflect)
        assert first.status_code == 401, first.text
        assert first.json()["status"] == "FAIL"
        # Signed out now: the same call no longer leaves the machine.
        second = await c.get("/api/v1/graph/conversation", headers=reflect)
    assert second.status_code == 200, second.text
    assert hp._state["hub_url"] not in second.text


async def test_with_the_hub_down_reads_fall_back_to_local_and_writes_fail_loudly(alice_token):
    import httpx

    url = await hp._desktop_for(alice_token, ("--then-hub", "http://127.0.0.1:9"))
    reflect = {"hub-reflect": "true"}
    async with httpx.AsyncClient(base_url=url, timeout=60) as c:
        read = await c.get("/api/v1/graph/conversation", headers=reflect)
        write = await c.post("/api/v1/graph/conversation", headers=reflect, json={"title": "hub is down"})
        local = await c.get("/api/v1/graph/conversation")
    assert read.status_code == 200, read.text
    assert write.status_code == 502 and write.json()["status"] == "FAIL", write.text
    assert "hub is down" not in local.text  # nothing was written locally behind the failure
