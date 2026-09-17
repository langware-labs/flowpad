"""A data source opened for reading: its pages from the stored position, or its items narrowed;
and ``merge(*sources)`` — several read as one, each page still one source's.

::

    async with await source.open() as live:
        async for page in live.pages(page_size=50):   # from the stored position
            ...; await page.ack()                     # un-acked = read again
        async for item in live.items(since=yesterday):  # narrows the query; no position change
            ...

    async with await merge(a, b).open() as live:
        async for page in live.pages():               # page.source names which
            ...; await page.ack()                     # that source's cursor only
        async for m in live.items(since=yesterday):   # k-way by event time
            await live.reply(m, body="on it")         # routed by m.origin

The source owns both the query (its config) and the cursor (its row), so neither is an argument
here. A merge owns nothing: no row, no cursor, no ``send`` — N positions stay on N rows.
"""
from __future__ import annotations

from typing import Any, AsyncIterator, Optional, Sequence

from flow_sdk.sources.base import Source
from flow_sdk.sources.protocols import Listable
from flow_sdk.sources.values.items import SourceItemSpec
from flow_sdk.sources.values.page import ChangePage, DataPage
from flow_sdk.sources.values.query import MessageQuery
from flow_sdk.utils.aiter_merge import merge_iterators


class Page:
    """One page read from the source, and the verb that moves the source's position past it."""

    def __init__(self, row: Any, page: DataPage) -> None:
        self.source = row
        self.page = page

    @property
    def items(self) -> list:
        return list(self.page.items)

    def __iter__(self):
        return iter(self.page.items)

    def __len__(self) -> int:
        return len(self.page.items)

    async def ack(self) -> None:
        """The page is handled: the next read starts after it."""
        resume = self.page.resume_cursor if isinstance(self.page, ChangePage) else None
        self.source.cursor = resume or self.page.next_cursor
        await self.source.save_runtime()


class SourceSession:
    """The configured ``source`` for ``row``, entered for the life of the ``async with``."""

    def __init__(self, row: Any, source: Source) -> None:
        self.row = row
        self.source = source

    async def __aenter__(self) -> "SourceSession":
        await self.source.__aenter__()
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        await self.source.__aexit__(exc_type, exc, traceback)

    async def pages(self, *, page_size: Optional[int] = None) -> AsyncIterator[Page]:
        """Every page from the row's position to the end of the stream, ``page_size`` items each
        (the driver's default when omitted). A first read (no position) starts at the source's
        window floor."""
        listable = self._listable()
        cursor = self.row.cursor if type(listable).durable_cursor else None
        narrow = None
        query = listable.query()
        if cursor is None and isinstance(query, MessageQuery) and query.since is None:
            narrow = {"since": self.row.window_floor()}
        while True:
            page = await listable.fetch(cursor, page_size=page_size, narrow=narrow)
            yield Page(self.row, page)
            if (cursor := page.next_cursor) is None:
                return

    def items(self, **narrow: Any) -> AsyncIterator[SourceItemSpec]:
        """The source's items with its query narrowed by ``narrow``; the position does not move."""
        self.check_narrow(narrow)
        return self._listable().iterate(narrow=narrow or None)

    def check_narrow(self, narrow: dict) -> None:
        """Refuse a field the source's query does not have, naming the source."""
        try:
            self._listable().effective_query(narrow or None)
        except ValueError as exc:
            raise ValueError(f"{self.row.name or self.row.id}: {exc}") from None

    def owns(self, item: Any) -> bool:
        """Whether ``item``'s origin is one this source would mint — ``origin(key)`` gives it back."""
        origin = getattr(item, "origin", None)
        try:
            return origin is not None and self.source.origin(origin.key) == origin
        except Exception:  # noqa: BLE001 — a scope that refuses the key does not own it
            return False

    def _listable(self) -> Source:
        if not isinstance(self.source, Listable):
            raise TypeError(f"{type(self.source).__name__} is push-only; it has no pages to read")
        return self.source


def merge(*sources: Any) -> "Merged":
    """Several data sources read as one. Nothing is stored: ``open()`` opens each source's own
    session, every page acks its own row, and a reply goes back through the source that owns the
    item's origin."""
    if not sources:
        raise ValueError("merge() needs at least one source")
    return Merged(sources)


class Merged:
    """N data sources, not yet open. No row, no cursor, no ``sync``, no ``send``."""

    def __init__(self, sources: Sequence[Any]) -> None:
        self.sources = list(sources)

    async def open(self, *, persona: bool = False) -> "MergedSession":
        sessions = [await source.open(persona=persona) for source in self.sources]
        for session in sessions:
            session._listable()  # a push-only source has nothing to read: refused before anything opens
        return MergedSession(sessions)


class MergedSession:
    """N ``SourceSession``s entered together — ``async with await merge(a, b).open() as live``."""

    def __init__(self, sessions: Sequence[SourceSession]) -> None:
        self.sessions = list(sessions)

    async def __aenter__(self) -> "MergedSession":
        opened: list[SourceSession] = []
        try:
            for session in self.sessions:
                await session.__aenter__()
                opened.append(session)
        except BaseException:
            for session in reversed(opened):
                await session.__aexit__(None, None, None)
            raise
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        for session in reversed(self.sessions):
            await session.__aexit__(exc_type, exc, traceback)

    @property
    def sources(self) -> list:
        return [session.row for session in self.sessions]

    def pages(self, *, page_size: Optional[int] = None) -> AsyncIterator[Page]:
        """Every source's pages as they land; one page is always one source's (``page.source``)."""
        return merge_iterators([session.pages(page_size=page_size) for session in self.sessions])

    async def items(self, **narrow: Any) -> AsyncIterator[SourceItemSpec]:
        """Every source's items with each query narrowed by ``narrow``, interleaved by event time
        (``sent_at`` / ``published_at``; undated last, per-source order otherwise). No position moves."""
        for session in self.sessions:
            session.check_narrow(narrow)
        async for item in _by_event_time([session.items(**narrow) for session in self.sessions]):
            yield item

    def source_of(self, item: Any) -> Any:
        """The data source whose scope owns ``item.origin``."""
        for session in self.sessions:
            if session.owns(item):
                return session.row
        raise LookupError(f"no source in this merge owns {getattr(item, 'origin', item)!r}")

    async def reply(self, item: Any, *, body: str, attachments=()):
        """Answer ``item`` through the source it came from, in that channel's own shape."""
        from flow_sdk.ingest.legacy_lift import envelope_of  # noqa: PLC0415

        source = self.source_of(item)
        envelope = envelope_of(item, data_source_id=str(source.id), provider=str(source.provider))
        return await source.send(source.reply_spec(envelope, body=body, attachments=attachments))


def _when(item: Any):
    data = getattr(item, "data", None)
    return getattr(data, "sent_at", None) or getattr(data, "published_at", None)


async def _by_event_time(iterators: Sequence[AsyncIterator[SourceItemSpec]]) -> AsyncIterator[SourceItemSpec]:
    """A k-way merge: the earliest head each step; an undated head waits until every dated one is
    out, then heads go in source order."""
    heads: list = [None] * len(iterators)
    done = [False] * len(iterators)

    async def advance(i: int) -> None:
        try:
            heads[i] = await iterators[i].__anext__()
        except StopAsyncIteration:
            heads[i], done[i] = None, True

    for i in range(len(iterators)):
        await advance(i)
    while not all(done):
        live = [i for i in range(len(iterators)) if not done[i]]
        dated = [i for i in live if _when(heads[i]) is not None]
        pick = min(dated, key=lambda i: _when(heads[i])) if dated else live[0]
        yield heads[pick]
        await advance(pick)


__all__ = ["Merged", "MergedSession", "Page", "SourceSession", "merge"]
