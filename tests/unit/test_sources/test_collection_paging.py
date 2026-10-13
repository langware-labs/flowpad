"""A ``CollectionSource`` lists its collection ONCE per traversal: the pages of one listing come from
one scan, kept for the session; a new traversal, session or query scans again."""

from __future__ import annotations

import pytest

from flow_sdk.sources import MemorySource
from tests.unit.test_sources.conftest import IssueData

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


async def _seeded(n: int) -> tuple[MemorySource, list]:
    source = MemorySource.of(IssueData, namespace="acme/issues")
    scans: list = []
    inner = source._scan

    async def counted(query):
        scans.append(query)
        return await inner(query)

    source._scan = counted  # type: ignore[method-assign]
    async with source:
        for i in range(n):
            await source.create(IssueData(title=f"issue {i}"))
    scans.clear()
    return source, scans


async def test_a_traversal_scans_the_collection_once():
    source, scans = await _seeded(5)
    async with source:
        keys, cursor, pages = [], None, 0
        while True:
            page = await source.fetch(cursor, page_size=2)
            pages += 1
            keys += [item.origin.key for item in page.items]
            if (cursor := page.next_cursor) is None:
                break
    assert pages == 3 and len(keys) == 5 and len(scans) == 1


async def test_a_new_traversal_or_session_scans_again():
    source, scans = await _seeded(3)
    async with source:
        first = await source.fetch(None, page_size=2)
        await source.fetch(first.next_cursor, page_size=2)
        await source.fetch(None, page_size=2)                     # from the start: a fresh listing
    assert len(scans) == 2
    async with source:
        await source.fetch(None, page_size=2)                     # another session: a fresh listing
    assert len(scans) == 3


async def test_a_continued_listing_is_one_snapshot():
    """A record made mid-traversal shows up in the NEXT traversal, not in the page after it was made."""
    source, scans = await _seeded(3)
    async with source:
        first = await source.fetch(None, page_size=2)
        await source.create(IssueData(title="late"))
        rest = await source.fetch(first.next_cursor, page_size=2)
        assert len(first.items) + len(rest.items) == 3 and rest.next_cursor is None
        assert len([i async for i in source.iterate(page_size=2)]) == 4
    assert len(scans) == 2
