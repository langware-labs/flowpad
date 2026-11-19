"""Read state kept the same here and at the provider (``flow_sdk/stream_inbox/reads.py``): a
message is born as the provider has it, a change there moves it here, a change here is written
there when the source says so — and neither side's stale word undoes the other's."""

from __future__ import annotations

import asyncio
import uuid

from flow_sdk.app.actions.flow_message_action import handle_stream_inbox_update
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.sync import sync_source
from flow_sdk.stream_inbox import reads
from flow_sdk.stream_inbox.projection import project_source_item
from tests.utils.fake_source import scripted_provider

PROVIDER = "chatreads"
DANA = "dana@chat.test"


async def _source() -> DataSource:
    me = f"{uuid.uuid4().hex[:8]}-me@chat.test"
    src = DataSource(name=f"chat {uuid.uuid4().hex[:8]}", provider=PROVIDER, account_key=me, config={"address": me})
    await src.save()
    return src


async def _land(script, src, key: str, **message) -> FlowMessage:
    script.push({"external_id": key, "author": DANA, "thread_key": "t1", "body": "hello", **message})
    await sync_source(src)
    row = await SourceItem.get_one({"data_source_id": str(src.id), "external_id": key})
    await project_source_item(row, source=src, announce=False)
    return await FlowMessage.get_one({"source_item_id": str(row.id)})


async def _is_read(message: FlowMessage) -> bool:
    return bool((await FlowMessage.get_one({"id": str(message.id)})).is_read)


async def _report(script, src, key: str, read: bool) -> None:
    script.push({"read_report": {"target": key, "read": read}})
    await sync_source(src)


async def _mark_here(message: FlowMessage, read: bool) -> None:
    await handle_stream_inbox_update(str(message.id), {"is_read": read}, f"user-{uuid.uuid4()}")
    await asyncio.gather(*(task for task in asyncio.all_tasks() if task.get_name() == reads.WRITE_BACK))


async def test_a_message_is_born_as_the_provider_has_it_and_follows_a_change_there():
    with scripted_provider(PROVIDER, projected=True) as script:
        src = await _source()
        seen = await _land(script, src, "seen", read=True)
        fresh = await _land(script, src, "fresh", read=False)
        unsaid = await _land(script, src, "unsaid")
        assert [seen.is_read, fresh.is_read, unsaid.is_read] == [True, False, False]

        await _report(script, src, "fresh", True)  # read at the provider
        assert await _is_read(fresh)
        await _report(script, src, "fresh", False)  # marked unread there
        assert not await _is_read(fresh)
        await _report(script, src, "not-here", True)  # a message this machine does not hold: dropped
        assert len(await SourceItem.get_all({"data_source_id": str(src.id)})) == 3, "a report is never a row"


async def test_a_stale_report_never_undoes_a_read_made_here():
    with scripted_provider(PROVIDER, projected=True) as script:
        src = await _source()
        message = await _land(script, src, "m1", read=False)
        await _mark_here(message, True)  # the source does not write back: the provider still says unread
        assert script.marked == []

        await _report(script, src, "m1", False)  # the provider repeats what it already said
        assert await _is_read(message), "nothing changed there, so nothing changes here"
        await _report(script, src, "m1", True)
        await _report(script, src, "m1", False)  # now it DID change there
        assert not await _is_read(message)


async def test_a_read_made_here_is_written_to_the_provider_when_the_source_says_so():
    with scripted_provider(PROVIDER, projected=True) as script:
        script.writes_read = True
        src = await _source()
        message = await _land(script, src, "m1", read=False)

        await _mark_here(message, True)
        await _mark_here(message, True)  # no change: nothing more is written
        await _mark_here(message, False)
        assert script.marked == [("m1", True), ("m1", False)]

        await _mark_here(message, True)
        await _report(script, src, "m1", True)  # the echo of our own write
        assert await _is_read(message) and script.marked[-1] == ("m1", True), "an echo is not written back again"
