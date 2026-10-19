"""A thread belongs to the account it was read from, not just to its channel.

Two mailboxes of one owner on one channel used to share a thread whenever their thread keys
matched — always, for a provider that gives no native handle and threads by subject: a
``Re: invoice`` from work mail and one from personal mail became a single conversation. The
thread's natural key now carries the source that read it, so accounts stay apart, re-projecting
converges on the same row, and a thread written before the key existed is adopted, not forked.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.stream_inbox.projection import project_source_item, resolve_thread

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _records_root(tmp_path, monkeypatch):
    monkeypatch.setattr("flow_sdk.fs_store.record_paths.get_default_records_data_root", lambda: tmp_path)


async def _mailbox(label: str) -> DataSource:
    source = DataSource(
        provider="agent", channel="gmail", name=f"{label} {uuid.uuid4().hex[:8]}",
        account_key=f"{label}-{uuid.uuid4().hex[:8]}@x.test", config={"connector": "gmail", "harness": "claude"},
    )
    await source.save()
    return source


async def _mail(source: DataSource, subject: str) -> SourceItem:
    """A message with no native thread handle: the projection threads it by subject."""
    item = SourceItem(
        id=str(uuid.uuid4()), data_source_id=source.id, provider="agent", kind="content.message.email",
        external_id=f"<{uuid.uuid4().hex[:8]}@x>", name=subject,
        body="see attached", author_external_id="billing@vendor.test",
    )
    await item.save(notify=False)
    return item


@pytest.mark.asyncio
async def test_the_same_subject_in_two_mailboxes_is_two_threads():
    subject = f"Re: invoice {uuid.uuid4().hex[:6]}"
    work, personal = await _mailbox("work"), await _mailbox("personal")

    _, work_thread = await project_source_item(await _mail(work, subject), source=work, notify=False, announce=False)
    _, home_thread = await project_source_item(await _mail(personal, subject), source=personal, notify=False, announce=False)

    assert work_thread != home_thread, "two accounts' mail must never share a thread"
    work_row, home_row = await MessageThread.get_by_id(work_thread), await MessageThread.get_by_id(home_thread)
    assert work_row.conversation_id != home_row.conversation_id


@pytest.mark.asyncio
async def test_one_mailbox_converges_on_its_thread():
    subject = f"Q3 planning {uuid.uuid4().hex[:6]}"
    work = await _mailbox("work")

    _, first = await project_source_item(await _mail(work, subject), source=work, notify=False, announce=False)
    _, reply = await project_source_item(await _mail(work, f"Re: {subject}"), source=work, notify=False, announce=False)

    assert first == reply


@pytest.mark.asyncio
async def test_a_thread_written_before_the_account_key_is_adopted_not_forked():
    key, owner = f"k-{uuid.uuid4()}", None
    work, personal = await _mailbox("work"), await _mailbox("personal")
    from flow_sdk.stream_inbox.projection import owner_of

    owner = await owner_of(work)
    legacy = MessageThread(id=str(uuid.uuid4()), channel="gmail", thread_key=key, owner=owner, conversation_id=str(uuid.uuid4()))
    await legacy.save(notify=False)

    adopted = await resolve_thread("gmail", key, owner, data_source_id=str(work.id), title="t")
    again = await resolve_thread("gmail", key, owner, data_source_id=str(work.id), title="t")
    other = await resolve_thread("gmail", key, owner, data_source_id=str(personal.id), title="t")

    assert adopted.id == legacy.id and again.id == legacy.id, "the reader's conversation is the one kept"
    assert (await MessageThread.get_by_id(legacy.id)).data_source_id == str(work.id)
    assert other.id != legacy.id, "a second account mints its own thread instead of claiming the first's"
