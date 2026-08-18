"""RSS/Atom driver — conditional GET, one stream per feed URL.

Uses ``httpx`` (already a dependency) and stdlib ``xml.etree``. ``feedparser`` is
deliberately not added: the fields we need are a dozen tag lookups, and this
package ships as a wheel where every transitive dependency is a liability.

**The cursor is the conditional-request pair.** ``{etag, last_modified}`` goes
out as ``If-None-Match`` / ``If-Modified-Since``; a **304** is the provider
saying "nothing changed", which costs one request and zero work. That is the
cheapest possible no-op poll, and it is why RSS is the right first driver — it
exercises the transport-level unchanged path that a naive design would skip.

**Absence is never deletion.** Feeds are windowed and routinely truncated to the
last N entries, so an item dropping off the end says nothing about whether it
still exists. This driver never reports a withdrawal.
"""
from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional
from xml.etree import ElementTree

from flow_sdk.ingest import http
from flow_sdk.ingest.driver import FetchResult, SegmentCursorView, SegmentRef
from flow_sdk.ingest.health import SourceError
from flow_sdk.ingest.models import IngestItem
from flow_sdk.utils.serialization import iso_to_datetime

_ATOM = "{http://www.w3.org/2005/Atom}"


class RssDriver:
    provider = "rss"
    kind = "datasource.feed.rss"
    record_kind = "content.feed.item"

    def segments(self, source) -> list[SegmentRef]:
        urls = (source.config or {}).get("feed_urls") or []
        return [SegmentRef(key=str(u), label=str(u)) for u in urls]

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        async with http.client() as client:
            response = await http.get(
                client,
                cursor.segment_key,
                headers=_conditional_headers(cursor.state),
                ok_statuses=(304,),
                hint="check the feed URL",
            )

        if response.status_code == 304:
            return FetchResult(items=[], next_state=dict(cursor.state or {}), unchanged=True)

        entries = _parse(response.text, cursor.segment_key)
        floor = _parse_iso(cursor.window_start)

        items: list[IngestItem] = []
        newest: Optional[datetime] = None
        for entry in entries:
            when = entry.get("occurred_at_dt")
            if floor is not None and when is not None and when < floor:
                continue
            if when is not None and (newest is None or when > newest):
                newest = when
            items.append(
                IngestItem(
                    source_id=source.id,
                    provider=self.provider,
                    kind=self.record_kind,
                    segment_key=cursor.segment_key,
                    segment_label=cursor.segment_key,
                    external_id=entry["external_id"],
                    title=entry.get("title") or "",
                    body=entry.get("body") or "",
                    occurred_at=when.isoformat() if when else None,
                    author_display=entry.get("author"),
                    permalink=entry.get("link"),
                    raw=entry.get("raw"),
                )
            )

        return FetchResult(
            items=items,
            next_state=_state_from(response.headers),
            high_water=newest.isoformat() if newest else None,
        )


def _conditional_headers(state: Optional[dict]) -> dict:
    state = state or {}
    headers = {}
    if state.get("etag"):
        headers["If-None-Match"] = state["etag"]
    if state.get("last_modified"):
        headers["If-Modified-Since"] = state["last_modified"]
    return headers


def _state_from(headers) -> dict:
    out = {}
    if headers.get("etag"):
        out["etag"] = headers["etag"]
    if headers.get("last-modified"):
        out["last_modified"] = headers["last-modified"]
    return out


def _parse(text: str, feed_url: str) -> list[dict]:
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as exc:
        # Not retryable: a URL that does not serve XML will not start doing so.
        raise SourceError.config("not_a_feed", f"could not parse as RSS/Atom: {exc}") from exc

    if root.tag == f"{_ATOM}feed":
        return [_atom_entry(e, feed_url) for e in root.findall(f"{_ATOM}entry")]

    channel = root.find("channel")
    if channel is not None:
        return [_rss_item(i, feed_url) for i in channel.findall("item")]

    raise SourceError.config("not_a_feed", f"unrecognised root element {root.tag!r}")


def _rss_item(item, feed_url: str) -> dict:
    guid = _text(item, "guid")
    link = _text(item, "link")
    title = _text(item, "title")
    return {
        # A feed without guids is legal; the link, then the title, is the next
        # most stable natural key. Falling back to a hash of the whole entry
        # would make every edit look like a new item.
        "external_id": guid or link or f"{feed_url}#{title}",
        "title": title,
        "body": _text(item, "description") or "",
        "link": link,
        "author": _text(item, "author"),
        "occurred_at_dt": _parse_rfc822(_text(item, "pubDate")),
        "raw": {"guid": guid, "link": link},
    }


def _atom_entry(entry, feed_url: str) -> dict:
    entry_id = _text(entry, f"{_ATOM}id")
    title = _text(entry, f"{_ATOM}title")
    link_el = entry.find(f"{_ATOM}link")
    link = link_el.get("href") if link_el is not None else None
    body = _text(entry, f"{_ATOM}content") or _text(entry, f"{_ATOM}summary") or ""
    author_el = entry.find(f"{_ATOM}author")
    author = _text(author_el, f"{_ATOM}name") if author_el is not None else None
    when = _parse_iso(_text(entry, f"{_ATOM}updated")) or _parse_iso(
        _text(entry, f"{_ATOM}published")
    )
    return {
        "external_id": entry_id or link or f"{feed_url}#{title}",
        "title": title,
        "body": body,
        "link": link,
        "author": author,
        "occurred_at_dt": when,
        "raw": {"id": entry_id, "link": link},
    }


def _text(node, tag: str) -> Optional[str]:
    if node is None:
        return None
    found = node.find(tag)
    if found is None or found.text is None:
        return None
    return found.text.strip()


def _parse_rfc822(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    """``iso_to_datetime`` plus the two guards feeds need: empty is not an
    error, and a tz-naive stamp is UTC rather than local."""
    if not value:
        return None
    try:
        parsed = iso_to_datetime(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
