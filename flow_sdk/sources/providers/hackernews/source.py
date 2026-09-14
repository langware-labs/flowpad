"""``HackerNewsSource`` — recently changed Hacker News items, one ``updates`` segment.

A changed-ids feed, the other shape beside RSS's conditional GET: ``/v0/updates`` names the
items that moved, each is hydrated from ``/v0/item/<id>``, and nothing is diffed on our side.
Re-seeing an unchanged item is free — the application's digest absorbs it — so no cursor is
carried between passes.

The pass is bounded (``MAX_ITEMS_PER_PASS`` newest changed ids): HN offers no server-side type
filter, so a persistently larger changed set leaves its tail unhydrated. A ceiling, not a queue.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, ClassVar, Optional

from flow_sdk.sources import http
from flow_sdk.sources.base import CollectionSource
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.values.items import FeedItemData, SourceItemSpec, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.segment import SegmentRef

BASE_URL = "https://hacker-news.firebaseio.com/v0"
MAX_ITEMS_PER_PASS = 60
#: HN has no per-channel partition: one segment.
STREAM_KEY = "updates"


class HackerNewsItemData(FeedItemData):
    spec_kind: ClassVar[str] = "ingest.feed.item.hackernews"
    #: ``score`` and ``kids`` move constantly: the echo never takes part in change detection.
    volatile: ClassVar[frozenset[str]] = frozenset({"raw"})

    raw: Optional[dict] = None


class HackerNewsSource(CollectionSource):
    provider = "hackernews"

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._client: Any = None
        self._entries: Optional[list[tuple[str, dict]]] = None

    @property
    def base_url(self) -> str:
        """Overridable so a mirror can be read; ordinary config, not a test seam."""
        return str(self.config.get("base_url") or BASE_URL).rstrip("/")

    def origin(self, key: str, *within: str) -> CloudOrigin:
        return super().origin(key, *(within or (STREAM_KEY,)))

    async def _open(self) -> None:
        self._client, self._entries = http.client(), None

    async def _close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def segments(self) -> list[SegmentRef]:
        return [SegmentRef(key=STREAM_KEY, label="Hacker News updates")]

    async def _lookup(self, key: str) -> Optional[dict]:
        """Within the recent changes this session sees — the same window the listing has."""
        return dict(await self._scan(None)).get(key)

    async def _scan(self, query: Any) -> list[tuple[str, dict]]:
        if self._entries is None:
            payload = await http.request_json(self._client, "GET", f"{self.base_url}/updates.json")
            ids = _ids(payload)[:MAX_ITEMS_PER_PASS]
            fetched = await asyncio.gather(
                *(http.request_json(self._client, "GET", f"{self.base_url}/item/{i}.json") for i in ids),
                return_exceptions=True,
            )
            # One unreadable item costs that item, not the pass.
            self._entries = sorted((str(raw["id"]), raw) for raw in fetched if isinstance(raw, dict) and self._wanted(raw))
        return self._entries

    def _wanted(self, raw: dict) -> bool:
        types = set(self.config.get("types") or ["story"])
        min_score = int(self.config.get("min_score") or 0)
        return (
            raw.get("id") is not None
            and raw.get("type") in types
            and not (raw.get("deleted") or raw.get("dead"))
            and int(raw.get("score") or 0) >= min_score
        )

    def _item(self, key: str, raw: dict) -> SourceItemSpec:
        by = raw.get("by")
        data = HackerNewsItemData(
            title=raw.get("title") or None,
            text=str(raw.get("text") or raw.get("url") or "") or None,
            url=raw.get("url") or None,
            published_at=_epoch(raw.get("time")),
            author=UserProfile(origin=self.origin(str(by)), name=str(by)) if by else None,
            raw=raw,
        )
        discussion = f"https://news.ycombinator.com/item?id={key}"
        return SourceItemSpec(origin=self.origin(key).model_copy(update={"url": discussion}), data=data)


def _ids(payload: Any) -> list[int]:
    out: list[int] = []
    for raw in (payload or {}).get("items") or [] if isinstance(payload, dict) else []:
        try:
            out.append(int(raw))
        except (TypeError, ValueError):
            continue
    return out


def _epoch(value: Any) -> Optional[datetime]:
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


__all__ = ["BASE_URL", "MAX_ITEMS_PER_PASS", "STREAM_KEY", "HackerNewsItemData", "HackerNewsSource"]
