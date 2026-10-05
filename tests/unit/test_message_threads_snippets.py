"""``docs/snippets/message-threads.md``, run as written.

§1–§2 on Flowpad's own chat (a native conversation, the app's own send queued locally — no
hub), §3 on a scripted data source channel whose conversation holds a projected thread.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.sync import sync_source
from flow_sdk.stream_inbox.projection import project_source_item
from tests.utils.fake_source import scripted_provider
from tests.utils.send_gate import logged_out
from tests.utils.snippets import doc, fence_under, run_fence

pytestmark = [pytest.mark.timeout(30), pytest.mark.usefixtures("fresh_user_scope")]  # do not increase timeout without approval

DOC = "message-threads.md"
PROVIDER = "threadsnip"
CUSTOMER = "dana@chat.test"


async def _native_chat() -> str:
    chat = Conversation(title="Ron, Eran")
    await chat.save()
    await chat._send_native("Take a snapshot from the home list", reply_to_id=None, thread_root_id=None)
    return str(chat.id)


async def _channel_conversation(script, address: str) -> str:
    src = DataSource(name=f"snip {uuid.uuid4().hex[:6]}", provider=PROVIDER, account_key=address, config={"address": address})
    await src.save()
    start = datetime.now(timezone.utc) - timedelta(minutes=10)
    for n in (1, 2):
        script.push({
            "external_id": f"q{n}", "author": CUSTOMER, "thread_key": "t1", "body": f"question {n}",
            "occurred_at": (start + timedelta(minutes=n)).isoformat(),
        })
        await sync_source(src)
        row = await SourceItem.get_one({"data_source_id": str(src.id), "external_id": f"q{n}"})
        await project_source_item(row, source=src, announce=False)
    return str((await FlowMessage.get_one({"source_item_id": str(row.id)})).conversation_id)


async def test_the_page_runs_as_written(monkeypatch):
    logged_out(monkeypatch)
    page = doc(DOC)
    ns = {"CONVERSATION_ID": await _native_chat()}

    # §1 — a reply opens the root's thread; a send into it joins without quoting.
    await run_fence(fence_under(page, "1."), ns, filename=f"{DOC} §1")
    answer, question = ns["answer"], ns["question"]
    assert answer.reply_to_id == question.id and answer.thread_root_id == question.id and answer.thread_id
    into = (await ns["chat"].messages())[-1]
    assert into.text == "Snapshot taken." and into.reply_to_id is None and into.thread_id == answer.thread_id

    # §2 — the thread reads back whole, named by its root.
    await run_fence(fence_under(page, "2."), ns, filename=f"{DOC} §2")
    assert ns["thread"].title == "Take a snapshot from the home list" and ns["thread"].message_count == 3
    assert [m["text"] for m in ns["read"]["messages"]] == [
        "Take a snapshot from the home list", "Which home — 43 or 51?", "Snapshot taken.",
    ]

    # §3 — the same verbs on a channel: into the thread unquoted, then answering one message.
    address = f"{uuid.uuid4().hex[:8]}@chat.test"
    with scripted_provider(PROVIDER, projected=True) as script:
        ns["CHANNEL_CONVERSATION_ID"] = await _channel_conversation(script, address)
        await run_fence(fence_under(page, "3."), ns, filename=f"{DOC} §3")
    into_thread, answering = script.sent[-2:]
    assert into_thread["thread_key"] == "t1" and into_thread["quoted"] == "" and into_thread["text"] == "Thanks — booked for Tuesday."
    assert answering["thread_key"] == "t1" and answering["in_reply_to"] == "q1"
