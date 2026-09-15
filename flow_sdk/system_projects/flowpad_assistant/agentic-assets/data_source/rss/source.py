"""``RssSource`` — RSS 2.0 and Atom feeds, one segment per feed URL.

``httpx`` (already a dependency) and ``xml.etree``; no ``feedparser`` — the fields are a dozen
tag lookups, and every transitive dependency of a shipped wheel is a liability.

**The resume cursor is the conditional-request pair.** A durable source: a feed's ``ETag`` and
``Last-Modified`` travel as ``resume_cursor``; handed back as the next traversal's cursor they go
out as ``If-None-Match`` / ``If-Modified-Since``, and a 304 is an empty page that resumes where
it was — one request, zero work.

**Absence is never deletion.** Feeds are windowed and truncated to their last N entries, so an
entry dropping off the end says nothing about whether it still exists. No removal is reported.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, ClassVar, Optional
from xml.etree import ElementTree

from flow_sdk.sources import http
from flow_sdk.sources.base import CollectionSource
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import InvalidCursor, Rejected
from flow_sdk.sources.values._types import NonBlank
from flow_sdk.sources.values.items import FeedItemData, SourceItemSpec
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import ChangePage
from flow_sdk.sources.values.query import DataQuery
from flow_sdk.sources.values.segment import SegmentRef

_ATOM = "{http://www.w3.org/2005/Atom}"
#: Marks a cursor as a resume token, not a page continuation.
_RESUME = "resume:"


class FeedQuery(DataQuery):
    """The entries of one feed."""

    spec_kind: ClassVar[str] = "source.query.feed"

    url: NonBlank


class RssSource(CollectionSource):
    provider = "rss"
    durable_cursor = True
    supported_queries = (FeedQuery,)

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._client: Any = None
        #: Per session: each feed's parsed entries and the resume token its response carried.
        self._feeds: dict[str, tuple[list[dict], Optional[str]]] = {}

    @property
    def feeds(self) -> list[str]:
        return [str(url) for url in self.config.get("feed_urls") or [] if url]

    def origin(self, key: str, *within: str) -> CloudOrigin:
        """An entry's identity is scoped by its feed — the first feed when none is named."""
        return super().origin(key, *(within or self.feeds[:1]))

    async def _open(self) -> None:
        self._client, self._feeds = http.client(), {}

    async def _close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def segments(self) -> list[SegmentRef]:
        return [SegmentRef(key=url, label=url, query=FeedQuery(url=url)) for url in self.feeds]

    async def get(self, origin: CloudOrigin) -> Optional[SourceItemSpec]:
        self._require_open()
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        url = next((u for u in self.feeds if self.origin(origin.key, u).namespace == origin.namespace), None)
        if origin.kind != self._scope.kind or url is None:
            raise ValueError(f"{origin!r} is outside this source's scope")
        return next((self._item(key, raw) for key, raw in await self._scan(FeedQuery(url=url)) if raw[1]["id"] == origin.key), None)

    async def fetch(self, query: Optional[DataQuery] = None, *, cursor: Optional[str] = None, page_size: Optional[int] = None) -> ChangePage:
        self._require_open()
        self._check_query(query)
        if isinstance(cursor, str) and cursor.startswith(_RESUME):
            if not isinstance(query, FeedQuery):
                raise InvalidCursor("a resume cursor belongs to one feed")
            if not await self._load(query.url, _conditions(cursor)):
                return ChangePage(items=(), resume_cursor=cursor)
            cursor = None
        page = await super().fetch(query, cursor=cursor, page_size=page_size)
        done = isinstance(query, FeedQuery) and page.next_cursor is None
        return ChangePage(items=page.items, next_cursor=page.next_cursor, resume_cursor=self._feeds[query.url][1] if done else None)

    async def _load(self, url: str, conditions: Optional[dict] = None) -> bool:
        """GET one feed into the session; ``False`` when the server answered "not modified"."""
        response = await http.request(
            self._client, "GET", url, headers=_headers(conditions or {}), ok_statuses=(304,), hint="check the feed URL"
        )
        if response.status_code == 304:
            return False
        self._feeds[url] = (_parse(response.text, url), _resume_of(response.headers))
        return True

    async def _lookup(self, key: str) -> Any:
        url = key.partition("\n")[0]
        return dict(await self._scan(FeedQuery(url=url))).get(key)

    async def _scan(self, query: Optional[DataQuery]) -> list[tuple[str, Any]]:
        entries: dict[str, Any] = {}
        for url in [query.url] if isinstance(query, FeedQuery) else self.feeds:
            if url not in self._feeds:
                await self._load(url)
            entries.update((f"{url}\n{entry['id']}", (url, entry)) for entry in self._feeds[url][0])
        return sorted(entries.items())

    def _item(self, key: str, raw: Any) -> SourceItemSpec:
        url, entry = raw
        data = FeedItemData(
            title=entry["title"], text=entry["body"], url=entry["link"], published_at=entry["published_at"], byline=entry["author"]
        )
        return SourceItemSpec(origin=self.origin(entry["id"], url), data=data)


def _headers(conditions: dict) -> dict:
    names = (("etag", "If-None-Match"), ("last_modified", "If-Modified-Since"))
    return {header: conditions[name] for name, header in names if conditions.get(name)}


def _resume_of(headers: Any) -> Optional[str]:
    pair = {name: headers.get(header) for name, header in (("etag", "etag"), ("last_modified", "last-modified")) if headers.get(header)}
    return _RESUME + json.dumps(pair, sort_keys=True) if pair else None


def _conditions(cursor: str) -> dict:
    try:
        pair = json.loads(cursor[len(_RESUME) :])
    except ValueError as exc:
        raise InvalidCursor("malformed resume cursor") from exc
    if not isinstance(pair, dict) or not all(isinstance(v, str) for v in pair.values()):
        raise InvalidCursor("malformed resume cursor")
    return pair


def _parse(text: str, feed_url: str) -> list[dict]:
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as exc:
        # A URL that does not serve XML will not start doing so: a person's to fix.
        raise Rejected(f"could not parse as RSS/Atom: {exc}") from exc
    if root.tag == f"{_ATOM}feed":
        return [_atom_entry(e, feed_url) for e in root.findall(f"{_ATOM}entry")]
    channel = root.find("channel")
    if channel is not None:
        return [_rss_item(i, feed_url) for i in channel.findall("item")]
    raise Rejected(f"unrecognised feed root element {root.tag!r}")


def _rss_item(item: Any, feed_url: str) -> dict:
    guid, link, title = _text(item, "guid"), _text(item, "link"), _text(item, "title")
    return {
        # A feed without guids is legal; the link, then the title, is the next most stable
        # key. A hash of the whole entry would make every edit look like a new item.
        "id": guid or link or f"{feed_url}#{title}",
        "title": title,
        "body": _text(item, "description"),
        "link": link,
        "author": _text(item, "author"),
        "published_at": _parse_rfc822(_text(item, "pubDate")),
    }


def _atom_entry(entry: Any, feed_url: str) -> dict:
    entry_id, title = _text(entry, f"{_ATOM}id"), _text(entry, f"{_ATOM}title")
    link_el = entry.find(f"{_ATOM}link")
    link = link_el.get("href") if link_el is not None else None
    author_el = entry.find(f"{_ATOM}author")
    return {
        "id": entry_id or link or f"{feed_url}#{title}",
        "title": title,
        "body": _text(entry, f"{_ATOM}content") or _text(entry, f"{_ATOM}summary"),
        "link": link,
        "author": _text(author_el, f"{_ATOM}name") if author_el is not None else None,
        "published_at": _parse_iso(_text(entry, f"{_ATOM}updated")) or _parse_iso(_text(entry, f"{_ATOM}published")),
    }


def _text(node: Any, tag: str) -> Optional[str]:
    found = None if node is None else node.find(tag)
    return found.text.strip() if found is not None and found.text is not None else None


def _parse_rfc822(value: Optional[str]) -> Optional[datetime]:
    try:
        parsed = parsedate_to_datetime(value) if value else None
    except (TypeError, ValueError):
        return None
    return parsed if parsed is None or parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    """Empty is not an error, and a naive stamp is UTC rather than local."""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None
    except ValueError:
        return None
    return parsed if parsed is None or parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


__all__ = ["FeedQuery", "RssSource"]
