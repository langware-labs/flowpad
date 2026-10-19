"""The local person's Tasks channel: their tasks as threads in their stream inbox — a standard message
source (``task_manager``, principal ``user:local``) pulled by the sync engine, nudged by the bus.

One instance, the owner's side, with the hub faked: what the other person does arrives the way the
hub delivers it (``materialize_remote_task`` for their status change, ``upsert_from_hub_child`` for
their comment). The two-machine leg of the same four scenarios is ``tests/hub_tests``.

S1 Task it → the task → its thread opens.  S2 assigned to someone else → the thread says so (and
the task went to the hub).  S3 the other person moves it / comments → a message here.  S4 a reply in
the thread → a comment on the task, shared through the hub.
"""
from __future__ import annotations

import asyncio

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.comment import Comment
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.builtin.task import Task
from flow_sdk.stream_inbox import outbound
from flow_sdk.stream_inbox.projection import project_source_item, reconcile_source
from flow_sdk.tasks import runtime
from flow_sdk.tasks.cos import ensure_user_tasks_channel

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

GRAPH = "/api/v1/graph"
ME = "owner@x.com"  # the fake login (``_FakeCreds``)
BOB = "bob@x.com"


@pytest.fixture
async def channel(bootstrapped_client, hub_faked, monkeypatch):
    import flow_sdk.cli.app_config as app_config  # noqa: PLC0415

    monkeypatch.setattr(app_config, "get_user", lambda: {"email": ME})
    runtime.start(watchdog=False)
    source = await ensure_user_tasks_channel()
    try:
        yield source
    finally:
        await runtime.settle()
        runtime.stop()
        await outbound.settle()
        await source.delete()


async def _thread(source, task_id: str) -> list[tuple[SourceItem, FlowMessage]]:
    """The task's thread as the stream inbox holds it: every projected message, oldest first."""
    await runtime.settle()
    await reconcile_source(str(source.id))
    rows = [r for r in await SourceItem.get_all({"data_source_id": str(source.id)}) if (r.external_id or "").startswith(task_id)]
    # What the `.item.updated` lane does in the app (not started here): re-project, so an update lands too.
    for row in rows:
        await project_source_item(row, source=source)
    out = []
    for row in rows:
        fm = await FlowMessage.get_one({"source_item_id": str(row.id)})
        assert fm is not None, f"{row.external_id} was ingested but never projected"
        out.append((row, fm))
    # The thread's order is event time: ``sent_at or updated_date or created_date`` (docs/glossary.md).
    return sorted(out, key=lambda pair: pair[1].sent_at or pair[1].updated_date or pair[1].created_date)


def _bodies(thread) -> list[str]:
    return [row.body or "" for row, _ in thread]


async def _task_it(client, text: str) -> Task:
    """What ``Task.fromMessage`` posts: a plain task, mine, its first line the title, pointing back at the message."""
    resp = await client.post(f"{GRAPH}/task", json={
        "type": "task", "title": text.splitlines()[0], "description": text, "assignee": ME, "reporter": ME,
        "origin_conversation": f"conv-{mint_uuid()[:8]}", "origin_message": f"msg-{mint_uuid()[:8]}",
    })
    assert resp.status_code == 200, resp.text
    return await Task.get_one({"id": resp.json()["data"]["id"]})


async def test_s1_task_it_opens_the_tasks_thread(channel, bootstrapped_client):
    task = await _task_it(bootstrapped_client, f"Set up the studio {mint_uuid()[:6]}\nwith the CRM")

    thread = await _thread(channel, task.id)
    assert _bodies(thread) == [task.description]
    row, fm = thread[0]
    assert row.is_ours(channel), "my own task opens as my own message, not as unread news"
    conversations = {str(fm.conversation_id) for _, fm in thread}
    assert len(conversations) == 1


async def test_s2_assigning_someone_else_shares_the_task_and_says_so(channel, bootstrapped_client, hub_faked):
    task = await _task_it(bootstrapped_client, f"Manage the pmf cycle {mint_uuid()[:6]}")

    resp = await bootstrapped_client.post(f"{GRAPH}/task/{task.id}/assign-task", json={"email": BOB})
    assert resp.status_code == 200, resp.text
    assert any(path.endswith(f"/task/{task.id}/members") and body["recipient_email"] == BOB
               for path, body in hub_faked["posts"]), "the task went to the hub for bob"

    thread = await _thread(channel, task.id)
    assert _bodies(thread)[-1] == f"Assigned to {BOB}"
    assert len({str(fm.conversation_id) for _, fm in thread}) == 1, "one task, one thread"


async def test_s3_the_other_persons_status_and_comment_arrive_in_the_thread(channel, bootstrapped_client):
    from flow_sdk.app.actions.task_receive import materialize_remote_task  # noqa: PLC0415

    task = await _task_it(bootstrapped_client, f"Generate the report {mint_uuid()[:6]}")
    assert (await bootstrapped_client.post(f"{GRAPH}/task/{task.id}/assign-task", json={"email": BOB})).status_code == 200

    # Bob moves it — the hub pushes his status (the assignee's field) back as a newer row.
    stored = await Task.get_one({"id": task.id})
    later = stored.updated_date.replace(year=stored.updated_date.year + 1)
    await materialize_remote_task({"id": task.id, "status": "in_progress", "updated_date": later.isoformat()}, None)
    # ...and the history comment his machine wrote for that move, as the hub delivers every child of the task.
    await Comment.upsert_from_hub_child({
        "id": mint_uuid(), "raw_content": "Status: In progress", "parent_type_id": str(task.typeid),
        "data": {"change": "status", "from": "to_do", "to": "in_progress", "author": BOB, "text": "Status: In progress"},
    }, str(task.typeid))
    # Bob comments from his task editor — the hub delivers it as a child of the task.
    await Comment.upsert_from_hub_child(
        {"id": mint_uuid(), "raw_content": "Started on it", "parent_type_id": str(task.typeid)}, str(task.typeid))

    thread = await _thread(channel, task.id)
    news = {row.body: row for row, _ in thread}
    assert "Status: In progress" in news and "Started on it" in news, _bodies(thread)
    for body in ("Status: In progress", "Started on it"):
        assert not news[body].is_ours(channel), f"{body!r} is bob's, not mine"
        assert news[body].author_external_id == BOB


async def test_s4_a_reply_in_the_thread_is_a_comment_shared_through_the_hub(channel, bootstrapped_client, hub_faked):
    task = await _task_it(bootstrapped_client, f"Ship it {mint_uuid()[:6]}")
    assert (await bootstrapped_client.post(f"{GRAPH}/task/{task.id}/assign-task", json={"email": BOB})).status_code == 200
    thread = await _thread(channel, task.id)
    conversation_id = str(thread[0][1].conversation_id)

    response = await outbound.dispatch_channel_reply(conversation_id, text="Any update?")
    assert getattr(response, "status", "") != "FAIL", getattr(response, "message", response)
    await asyncio.gather(*list(outbound._INFLIGHT))  # noqa: SLF001

    # The reply, beside the hand-over's history comment.
    comments = [c for c in await Comment.get_all({"parent_type_id": str(task.typeid)}) if not (c.data or {}).get("change")]
    assert [(c.data or {}).get("text") for c in comments] == ["Any update?"]
    assert (comments[0].data or {}).get("author") == ME
    assert (task.id, comments[0].id) in hub_faked["children"], "the comment went to the hub under the shared task"

    thread = await _thread(channel, task.id)
    mine = [row for row, _ in thread if row.body == "Any update?"]
    assert len(mine) == 1 and mine[0].is_ours(channel), "recorded once, as mine"


# ── round 2: history, the other person's moves, reassignment, rename, the thread's own surface ──────
async def _assigned_to_bob(client) -> Task:
    task = await _task_it(client, f"Shared work {mint_uuid()[:6]}")
    assert (await client.post(f"{GRAPH}/task/{task.id}/assign-task", json={"email": BOB})).status_code == 200
    return task


async def _set_status(client, task: Task, status: str) -> None:
    resp = await client.put(f"{GRAPH}/task/{task.id}", json={"status": status})
    assert resp.status_code == 200, resp.text


async def test_my_status_change_is_history_both_threads_read(channel, bootstrapped_client, hub_faked):
    task = await _assigned_to_bob(bootstrapped_client)
    await _set_status(bootstrapped_client, task, "in_progress")

    history = [c for c in await Comment.get_all({"parent_type_id": str(task.typeid)}) if (c.data or {}).get("change") == "status"]
    assert len(history) == 1 and (history[0].data or {})["author"] == ME
    assert (task.id, history[0].id) in hub_faked["children"], "a shared task's history goes to the hub: bob reads it too"
    news = [row for row, _ in await _thread(channel, task.id) if row.body == "Status: In progress"]
    assert len(news) == 1 and news[0].is_ours(channel), "my own move, credited to me"


async def test_the_other_persons_status_is_credited_to_them(channel, bootstrapped_client):
    task = await _assigned_to_bob(bootstrapped_client)
    # Bob's machine wrote his history comment; the hub delivers it here as a child of the task.
    await Comment.upsert_from_hub_child({
        "id": mint_uuid(), "raw_content": "Status: In progress", "parent_type_id": str(task.typeid),
        "data": {"change": "status", "from": "to_do", "to": "in_progress", "author": BOB, "text": "Status: In progress"},
    }, str(task.typeid))

    (row,) = [r for r, _ in await _thread(channel, task.id) if r.body == "Status: In progress"]
    assert row.author_external_id == BOB and not row.is_ours(channel)


async def test_done_reopened_done_is_three_messages(channel, bootstrapped_client):
    task = await _assigned_to_bob(bootstrapped_client)
    for status in ("done", "in_progress", "done"):
        await _set_status(bootstrapped_client, task, status)
    bodies = _bodies(await _thread(channel, task.id))
    assert bodies.count("Status: Done") == 2 and bodies.count("Status: In progress") == 1, bodies


async def test_reassigning_takes_the_task_back_from_the_previous_assignee(channel, bootstrapped_client, hub_faked, monkeypatch):
    import flow_sdk.app.actions.task_assign_action as taa  # noqa: PLC0415

    revoked: list[tuple[str, dict]] = []

    async def fake_hub_delete(entity_type, entity_id, action=None, *a, payload=None, **k):
        revoked.append((f"/graph/{getattr(entity_type, 'value', entity_type)}/{entity_id}/{action}", payload))
        return {}

    monkeypatch.setattr(taa, "hub_delete", fake_hub_delete)
    task = await _assigned_to_bob(bootstrapped_client)
    assert revoked == [], "handing over my own task takes it from no one"

    carol = "carol@x.com"
    assert (await bootstrapped_client.post(f"{GRAPH}/task/{task.id}/assign-task", json={"email": carol})).status_code == 200

    assert revoked == [(f"/graph/task/{task.id}/members", {"user_email": BOB})]
    assert any(path.endswith("/members") and body.get("recipient_email") == carol for path, body in hub_faked["posts"])
    assert f"Reassigned to {carol}" in _bodies(await _thread(channel, task.id))


async def test_the_thread_follows_a_rename(channel, bootstrapped_client):
    task = await _task_it(bootstrapped_client, f"Old name {mint_uuid()[:6]}")
    thread = await _thread(channel, task.id)
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415

    conversation_id = str(thread[0][1].conversation_id)
    new_title = f"New name {mint_uuid()[:6]}"
    assert (await bootstrapped_client.put(f"{GRAPH}/task/{task.id}", json={"title": new_title})).status_code == 200
    await _thread(channel, task.id)
    assert (await Conversation.get_one({"id": conversation_id})).title == new_title


async def test_the_thread_carries_the_task_and_waits_for_no_one(channel, bootstrapped_client):
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415

    task = await _assigned_to_bob(bootstrapped_client)
    thread = await _thread(channel, task.id)
    root = next(fm for row, fm in thread if row.external_id == f"{task.id}:created")
    assert [str(t) for t in root.shared_context_entities] == [f"task-{task.id}"], "the thread can show and act on its task"
    conversation = await Conversation.get_one({"id": str(root.conversation_id)})
    assert conversation.channel_answered is False, "a person's own Tasks channel: nobody else picks its messages up"
    assert not any(a == task.id for a in (conversation.address or [])), "no task id among who the thread is with"


async def test_a_change_after_the_first_pull_arrives_as_news(channel, bootstrapped_client):
    """A steady pull lists only what changed since the last one, so a change is ingested as an arrival
    — its item tag is what projects it (and re-projects an update) in the app. A pull that re-listed the
    whole window went over the storm cap, ingested silently, and an update never reached the thread."""
    from flow_sdk.tags import on_tag  # noqa: PLC0415

    from flow_sdk.ingest.models import STORM_CAP_PER_MINUTE  # noqa: PLC0415

    from datetime import datetime, timedelta, timezone  # noqa: PLC0415

    from flow_sdk.core.entity.entity_model import remote_reflection  # noqa: PLC0415

    # Enough of my tasks in the window that re-listing it all would cross the storm cap — written an hour ago
    # (a reflection save keeps the stamps it is given), so they are backlog, not news.
    old = datetime.now(timezone.utc) - timedelta(hours=1)
    with remote_reflection():
        for n in range(STORM_CAP_PER_MINUTE + 1):
            await Task(placement="instance", title=f"backlog {n} {mint_uuid()[:6]}", assignee=ME, reporter=ME,
                       created_date=old, updated_date=old).save()
    task = await _assigned_to_bob(bootstrapped_client)
    await _thread(channel, task.id)  # the first pulls are behind us
    heard: list[tuple[str, str]] = []
    unsubscribe = on_tag("ingest.task_manager.item.*", lambda e: heard.append((e.tag, str((e.data or {}).get("external_id") or ""))))
    try:
        await _set_status(bootstrapped_client, task, "in_progress")
        await runtime.settle()
    finally:
        unsubscribe()
    assert any(tag.endswith(".item.created") and ext.startswith(task.id) for tag, ext in heard), heard
