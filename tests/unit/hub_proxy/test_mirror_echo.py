"""The post-proxy mirror: hub answers folded into the rows this box keeps (real servers)."""

from __future__ import annotations

import json
import uuid

import httpx

REFLECT = {"Hub-Reflect": "true"}

ROSTER = [
    {"user_id": "u-alice", "user_email": "alice@example.com", "user_name": "Alice", "role": "owner", "status": "approved"},
    {"user_id": "u-bob", "user_email": "bob@example.com", "user_name": "Bob", "role": "member", "status": "approved"},
]
LOCAL_ROSTER = [
    {"user_id": "u-alice", "role": "owner", "status": "approved", "email": "alice@example.com", "name": "Alice"},
    {"user_id": "u-bob", "role": "member", "status": "approved", "email": "bob@example.com", "name": "Bob"},
]


async def _remote_conversation():
    from flow_sdk.builtin.conversation import Conversation

    conv = Conversation(id=str(uuid.uuid4()), title="t", members=[{"user_id": "stale"}])
    conv.remote = True
    await conv.save()
    return conv


async def _get(cls, entity_id):
    return await cls.get_by_id(entity_id)


async def test_a_roster_read_answers_the_hubs_shape_and_caches_it_locally(desktop, echo_hub):
    from flow_sdk.builtin.conversation import Conversation

    conv = await _remote_conversation()
    path = f"/api/v1/graph/conversation/{conv.id}/members"
    async with httpx.AsyncClient(base_url=desktop) as c:
        r = await c.get(path, params={"require_authoritative": "true"},
                        headers={**REFLECT, "x-echo-mode": "answer", "x-echo-answer": json.dumps(ROSTER)})  # fmt: skip
    assert r.json()["data"] == ROSTER  # verbatim: the hub's field names
    assert echo_hub.received[0].query == "require_authoritative=true"  # the query travels as sent
    assert (await _get(Conversation, conv.id)).members == LOCAL_ROSTER  # the local cache keeps its shape


async def test_a_roster_change_answers_the_hub_and_re_reads_the_roster(desktop, echo_hub):
    from flow_sdk.builtin.conversation import Conversation

    conv = await _remote_conversation()
    path = f"/api/v1/graph/conversation/{conv.id}/members"
    echo_hub.scripted[("GET", path)] = ROSTER
    async with httpx.AsyncClient(base_url=desktop) as c:
        r = await c.request("DELETE", path, json={"member_through": "user_id", "value": "u-carol"}, headers=REFLECT)
    assert r.status_code == 200 and r.json()["data"]["method"] == "DELETE"  # the mutation's own answer
    assert json.loads(echo_hub.received[0].body) == {"member_through": "user_id", "value": "u-carol"}
    assert [(x.method, x.raw_path) for x in echo_hub.all_received if x.raw_path == path] == [
        ("DELETE", path),
        ("GET", path),
    ]
    assert (await _get(Conversation, conv.id)).members == LOCAL_ROSTER


async def test_a_members_sub_endpoint_is_not_a_roster(desktop, echo_hub):
    from flow_sdk.builtin.conversation import Conversation

    conv = await _remote_conversation()
    link = {"id": "L1", "url": "https://x/accept"}
    async with httpx.AsyncClient(base_url=desktop) as c:
        r = await c.post(f"/api/v1/graph/conversation/{conv.id}/members/link", json={},
                         headers={**REFLECT, "x-echo-mode": "answer", "x-echo-answer": json.dumps(link)})  # fmt: skip
    assert r.json()["data"] == link
    assert [x.raw_path for x in echo_hub.all_received if "/members" in x.raw_path] == [
        f"/api/v1/graph/conversation/{conv.id}/members/link"
    ]  # no roster re-read
    assert (await _get(Conversation, conv.id)).members == [{"user_id": "stale"}]


async def test_hub_owned_collections_merge_onto_the_local_row(sod_env, tmp_path):
    """A task's hub-modeled ``artifacts`` collection merges like a scalar. Called on the real
    ``mirror_answer`` with a real row (the HTTP path is pinned by the conversation cases above)."""
    from flow_sdk.builtin.task import Task
    from flow_sdk.request_context import methods as ctx
    from flow_sdk.server.routes._hub_reflect import mirror_answer, parse_graph_path
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    ctx.set_default_test_storage_fallback(LocalStorageDriver(str(tmp_path / "blobs")))
    try:
        task = Task(id=str(uuid.uuid4()), title="old", placement="instance")
        task.remote = True
        await task.save()
        arts = [{"type": "link", "url": "https://example.com/a"}]
        raw = json.dumps({"status": "SUCCESS", "data": {"id": task.id, "type": "task", "title": "new", "artifacts": arts}})
        await mirror_answer("PUT", parse_graph_path(f"/api/v1/graph/task/{task.id}"), task, raw.encode())
        local = await _get(Task, task.id)
        assert local.title == "new"
        assert [a if isinstance(a, dict) else a.model_dump(exclude_none=True) for a in local.artifacts] == arts
    finally:
        ctx.set_default_test_storage_fallback(None)


async def test_an_action_answering_the_row_folds_it_in(desktop, echo_hub):
    """``close`` answers the settled conversation: the local row (what the portal reads) follows."""
    from flow_sdk.builtin.conversation import Conversation

    conv = await _remote_conversation()
    settled = {"id": conv.id, "type": "conversation", "status": "closed"}
    async with httpx.AsyncClient(base_url=desktop) as c:
        r = await c.post(f"/api/v1/graph/conversation/{conv.id}/close", json={},
                         headers={**REFLECT, "x-echo-mode": "answer", "x-echo-answer": json.dumps(settled)})  # fmt: skip
    assert r.json()["data"] == settled
    assert str((await _get(Conversation, conv.id)).status).endswith(("closed", "CLOSED"))


async def test_an_action_answering_something_else_leaves_the_row(desktop, echo_hub):
    from flow_sdk.builtin.conversation import Conversation

    conv = await _remote_conversation()
    other = {"id": str(uuid.uuid4()), "type": "flow_message", "title": "not the conversation"}
    async with httpx.AsyncClient(base_url=desktop) as c:
        await c.post(f"/api/v1/graph/conversation/{conv.id}/add_message", json={},
                     headers={**REFLECT, "x-echo-mode": "answer", "x-echo-answer": json.dumps(other)})  # fmt: skip
    assert (await _get(Conversation, conv.id)).title == "t"
