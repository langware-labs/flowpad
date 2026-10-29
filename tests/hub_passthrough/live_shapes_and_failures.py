"""Live hub, through a desktop: the call sites and failure modes the hub suite does not reach.

    uv run pytest -p flowpad.hub.tests.conftest -p hub_passthrough_plugin <this file>
"""

from __future__ import annotations

import asyncio
import json

import hub_passthrough_plugin as hp
import pytest

# The real ``HelpdeskSource`` from this checkout, run in the desktop's own environment, reaching the
# hub through the staff member's desktop over HTTP: the pool and the messages are the hub's answers.
_STAFF_SOURCE = """
import asyncio, json, sys
import httpx
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.sources.binding import SourceBinding

desktop, token, desk, cursor = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] or None
headers = {"Authorization": f"Bearer {token}", "hub-reflect": "true"}


class Desktop:
    async def get(self, entity_type, entity_id, action, *, params=None):
        async with httpx.AsyncClient(base_url=desktop, timeout=60, headers=headers) as c:
            r = await c.get(f"/api/v1/graph/{entity_type}/{entity_id}/{action}", params=params)
        r.raise_for_status()
        return r.json().get("data")

    async def post(self, entity_type, payload, entity_id, action):
        raise AssertionError("a read pass never writes")

    def me(self):
        return "staff"


async def main():
    source_cls = asset_module("helpdesk").HelpdeskSource
    items = []
    async with source_cls(SourceBinding(config={"desk_project_id": desk}), hub=Desktop()) as source:
        page = await source.fetch(cursor)
        items.extend((i.data.hub_conversation_id, i.data.text) for i in page.items)
        while page.next_cursor is not None:
            page = await source.fetch(page.next_cursor)
            items.extend((i.data.hub_conversation_id, i.data.text) for i in page.items)
    print("RESULT " + json.dumps({"items": items, "cursor": page.resume_cursor}))


asyncio.run(main())
"""


async def _staff_pass(token: str, desk_id: str, cursor: str | None) -> tuple[list[tuple[str, str]], str]:
    desktop = await hp._desktop_for(token)
    assert desktop, "the staff member needs a desktop"
    proc = await asyncio.create_subprocess_exec(
        "uv", "run", "--project", str(hp.OSS_ROOT), "python", "-c", _STAFF_SOURCE, desktop, token, desk_id, cursor or "",
        cwd=str(hp.OSS_ROOT), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        env={k: v for k, v in hp.os.environ.items() if not k.startswith(("NEO4J_", "PYTEST_", "VIRTUAL_ENV", "PYTHONPATH"))},
    )  # fmt: skip
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
    text = out.decode("utf-8", "replace")
    line = next((x for x in text.splitlines() if x.startswith("RESULT ")), None)
    assert proc.returncode == 0 and line, text[-3000:]
    result = json.loads(line[len("RESULT "):])
    return [tuple(i) for i in result["items"]], result["cursor"]


def _desk_helpers():
    from flowpad.hub.tests.api.test_conversation import _desk_for

    return _desk_for


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


@pytest.mark.parametrize("which", ["customer", "flowpad"])
async def test_staff_source_lists_closed_tickets_and_pulls_a_reply_after_close(
    which, service, alice_user, bob_user, bob_token, charlie_token
):
    """D7: a closed ticket stays in the staff source's pool; D6: a reply after close still arrives."""
    desk = await _desk_helpers()(which, alice_user, staff=[bob_user])
    guest = {"Authorization": f"Bearer {charlie_token}"}
    staff = {"Authorization": f"Bearer {bob_token}"}
    async with hp._passthrough_client(service, headers=guest) as c:
        r = await c.post(f"/api/v1/graph/project/{desk.id}/start_guest_conversation", json={"text": "printer on fire"})
        assert r.status_code == 200, r.text
        ticket = r.json()["data"]["id"]

    first, cursor = await _staff_pass(bob_token, desk.id, None)
    assert (ticket, "printer on fire") in first

    async with hp._passthrough_client(service, headers=staff) as s:
        assert (await s.post(f"/api/v1/graph/conversation/{ticket}/close", json={})).status_code == 200
    closed, cursor = await _staff_pass(bob_token, desk.id, cursor)
    assert [i for i in closed if i[0] == ticket] == [], "closing adds no message"

    async with hp._passthrough_client(service, headers=guest) as c:
        r = await c.post(f"/api/v1/graph/conversation/{ticket}/add_message", json={"text": "still burning"})
        assert r.status_code == 200, r.text
    after, _ = await _staff_pass(bob_token, desk.id, cursor)
    assert (ticket, "still burning") in after, "a reply to a closed ticket reaches staff"

    import httpx

    # helpdesk-tickets-list is the desktop's own action: ask bob's desktop, which asks the hub.
    async with httpx.AsyncClient(base_url=await hp._desktop_for(bob_token), timeout=60, headers=staff) as s:
        listed = await s.post("/api/v1/graph/helpdesk-tickets-list", json={"desk_project_id": desk.id, "include_closed": True})
        default = await s.post("/api/v1/graph/helpdesk-tickets-list", json={"desk_project_id": desk.id})
    assert listed.json().get("data"), listed.text
    rows = {r["conversation_id"]: r for r in listed.json()["data"]["tickets"]}
    assert rows[ticket]["status"] == "closed", listed.text
    assert ticket not in {r["conversation_id"] for r in default.json()["data"]["tickets"]}


async def test_diagnosis_desk_ticket_is_titled_by_its_one_liner(service, alice_user, bob_user, bob_token, charlie_token):
    """D1: the hub titles a ticket by its opening line, and a desktop's diagnosis opens with its one-liner."""
    import httpx

    desk = await _desk_helpers()("customer", alice_user, staff=[bob_user])
    one_liner = "gtm-studio update fails: an agent.json lists requirements"
    url = await hp._desktop_for(charlie_token)
    async with httpx.AsyncClient(base_url=url, timeout=60, headers={"Authorization": f"Bearer {charlie_token}"}) as d:
        made = await d.post("/api/v1/graph/flowpad_diagnosis", json={
            "title": one_liner, "summary": "One agent.json cannot be read.", "status": "needs_action",
            "user_report": "analyze the error: Couldn't update",
        })
        assert made.status_code == 200, made.text
        did = made.json()["data"]["id"]
        share = [{"kind": "desk", "name": "Desk", "desk_project_id": desk.id}]
        sent = await d.post("/api/v1/graph/diagnose-send", json={"diagnosis_id": did, "share_with": share})
        assert sent.status_code == 200 and sent.json()["status"] == "SUCCESS", sent.text
    ticket = sent.json()["data"]["shared"][0]["conversation_id"]
    async with hp._state["original"](service, headers={"Authorization": f"Bearer {bob_token}"}) as h:
        for _ in range(40):
            rows = (await h.get(f"/api/v1/graph/project/{desk.id}/helpdesk_conversations",
                                params={"include_closed": "true"})).json()["data"]
            row = next((r for r in rows if r["conversation_id"] == ticket), None)
            if row is not None:
                break
            await asyncio.sleep(0.25)
        msgs = (await h.get(f"/api/v1/graph/conversation/{ticket}/messages")).json()["data"]
    assert row is not None, f"ticket {ticket} never reached the desk"
    assert row["title"] == one_liner, row
    assert msgs[0]["text"].split("\n")[0] == one_liner, msgs[0]["text"]


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
