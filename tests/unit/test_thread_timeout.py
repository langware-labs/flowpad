"""A source's ``thread_timeout_seconds``: a thread quiet that long is over, and the next message on
the same chat starts a new thread — a new conversation — on top of the driver's own split.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.stream_inbox.projection import find_thread, owner_of, project_source_item

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

T0 = datetime(2026, 9, 24, 9, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _records_root(tmp_path, monkeypatch):
    monkeypatch.setattr("flow_sdk.fs_store.record_paths.get_default_records_data_root", lambda: tmp_path)


async def _chat(timeout: Optional[int]) -> DataSource:
    source = DataSource(
        provider="agent", channel="telegram", name=f"chat {uuid.uuid4().hex[:8]}",
        account_key=f"bot-{uuid.uuid4().hex[:8]}", config={"connector": "telegram", "harness": "claude"},
        thread_timeout_seconds=timeout,
    )
    await source.save()
    return source


async def _say(source: DataSource, chat: str, minutes: int, text: str = "hi", *, ours: bool = False) -> tuple[str, MessageThread]:
    item = SourceItem(
        id=str(uuid.uuid4()), data_source_id=source.id, provider="agent", kind="content.message.chat",
        external_id=f"{chat}/{uuid.uuid4().hex[:8]}", thread_key=chat, body=text, sent_by_us=ours,
        author_external_id="me" if ours else "dana", occurred_at=(T0 + timedelta(minutes=minutes)).isoformat(),
    )
    await item.save(notify=False)
    _, thread_id = await project_source_item(item, source=source, notify=False, announce=False)
    return item.id, await MessageThread.get_by_id(thread_id)


@pytest.mark.asyncio
async def test_a_message_after_the_timeout_starts_a_new_thread_and_conversation():
    source, chat = await _chat(timeout=600), f"chat-{uuid.uuid4().hex[:6]}"

    _, first = await _say(source, chat, 0)
    _, same = await _say(source, chat, 9)  # 9 minutes of quiet < 10
    _, after = await _say(source, chat, 30)  # 21 minutes of quiet > 10

    assert same.id == first.id
    assert after.id != first.id and after.conversation_id != first.conversation_id
    current = await find_thread("telegram", chat, await owner_of(source), str(source.id))
    assert current.id == after.id, "the chat's key names the new thread — what the agent serves next"
    closed = await MessageThread.get_by_id(first.id)
    assert closed.conversation_id == first.conversation_id and closed.message_count == 2


@pytest.mark.asyncio
async def test_without_a_timeout_a_chat_is_one_thread():
    source, chat = await _chat(timeout=None), f"chat-{uuid.uuid4().hex[:6]}"

    _, first = await _say(source, chat, 0)
    _, days_later = await _say(source, chat, 60 * 24 * 3)

    assert days_later.id == first.id


@pytest.mark.asyncio
async def test_a_placed_message_stays_in_its_thread_and_a_backfill_ends_nothing():
    source, chat = await _chat(timeout=600), f"chat-{uuid.uuid4().hex[:6]}"
    first_item, first = await _say(source, chat, 0)
    _, after = await _say(source, chat, 30)

    replayed = await project_source_item(await SourceItem.get_by_id(first_item), source=source, notify=False, announce=False)
    _, late = await _say(source, chat, 20)  # arrives now, older than the thread's newest message

    assert replayed[1] == first.id, "re-projecting never moves a message into the newer thread"
    assert late.id == after.id


@pytest.mark.asyncio
async def test_a_slow_answer_stays_in_the_thread_it_answers():
    """The agent's turn took longer than the timeout: its answer still answers THAT thread."""
    source, chat = await _chat(timeout=600), f"chat-{uuid.uuid4().hex[:6]}"

    _, asked = await _say(source, chat, 0, "what is the code word?")
    _, answered = await _say(source, chat, 15, "PELICAN", ours=True)

    assert answered.id == asked.id


def test_a_changed_timeout_restarts_the_loop_that_holds_the_source():
    from flow_sdk.builtin.agent_serve import serving_key

    source = DataSource(provider="agent", channel="telegram", name="chat")
    before = serving_key(source)
    source.thread_timeout_seconds = 600

    assert serving_key(source) != before, "the loop's copy of the source would keep the old timeout"
