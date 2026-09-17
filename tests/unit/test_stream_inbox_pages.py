"""``StreamInbox.pages(size=N)``: pages of N with one ack each; ``listen()`` is the same drain flattened."""
from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.blocks import StreamInbox, workflow
from flow_sdk.builtin.consumer_position import ConsumerPosition, key_of
from tests.utils.fake_source import scripted_provider

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def _take(agen, n: int) -> list:
    out = []
    try:
        for _ in range(n):
            out.append(await agen.__anext__())
    finally:
        await agen.aclose()
    return out


def _name() -> str:
    return f"pages-{mint_uuid()}"


def _messages(n: int, *, author: str = "someone@example.com") -> list[dict]:
    return [{"body": f"m{i:03d}", "author": author, "thread_key": f"t{i}"} for i in range(n)]


async def test_pages_are_size_n_and_a_page_ack_commits_its_last_row():
    with scripted_provider("pager") as script:
        script.push(*_messages(120))
        box = StreamInbox(f"{mint_uuid()}@pager", provider="pager")
        name = _name()
        async with workflow(name):
            pages = await _take(box.pages(size=50, poll_every=0), 3)
            assert [len(p) for p in pages] == [50, 50, 20]
            assert [m.body for m in pages[0]][:2] == ["m000", "m001"], "ingest order"

            await pages[0].ack()

            source = await box.ensure_source()
            position = await ConsumerPosition.ensure_for(name, str(source.id))
            assert position.watermark() == key_of(pages[0].items[-1]._row)
            assert position.acked_count == 1, "one write per page, not one per item"
            assert pages[0].acked and not pages[1].acked


async def test_an_unacked_page_is_redelivered_on_the_next_run():
    with scripted_provider("pager-redeliver") as script:
        script.push(*_messages(60))
        box = StreamInbox(f"{mint_uuid()}@pager", provider="pager-redeliver")
        name = _name()
        async with workflow(name):
            first, second = await _take(box.pages(size=50, poll_every=0), 2)
            await first.ack()
        async with workflow(name):
            (again,) = await _take(box.pages(size=50, poll_every=0), 1)
            assert [m.body for m in again] == [m.body for m in second]
            assert all(m.redelivered for m in again)


async def test_filtered_rows_are_dropped_from_the_page_but_covered_by_its_ack():
    with scripted_provider("pager-filter") as script:
        script.push(*_messages(4, author="alice@example.com"), *_messages(2, author="mallory@example.com"))
        box = StreamInbox(f"{mint_uuid()}@pager", provider="pager-filter", senders=["alice@example.com"])
        name = _name()
        async with workflow(name):
            (page,) = await _take(box.pages(size=50, poll_every=0), 1)
            assert len(page) == 4 and {m.author_external_id for m in page} == {"alice@example.com"}
            await page.ack()
            source = await box.ensure_source()
            position = await ConsumerPosition.ensure_for(name, str(source.id))
            assert position.watermark() == key_of(page._last), "the ack covers the filtered rows too"


async def test_listen_is_pages_flattened():
    with scripted_provider("pager-flat") as script:
        script.push(*_messages(7))
        a = StreamInbox(f"{mint_uuid()}@pager", provider="pager-flat")
        b = StreamInbox(a.address, provider="pager-flat")
        items = await _take(a.listen(poll_every=0, page=3), 7)
        script.push(*_messages(7))
        pages = await _take(b.pages(size=3, poll_every=0), 3)
        assert [m.body for m in items] == [m.body for p in pages for m in p]
