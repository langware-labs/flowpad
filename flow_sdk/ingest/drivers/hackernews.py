"""Hacker News driver — the abstraction gate.

RSS proves conditional GET. This proves the *other* cursor shape: a feed that
tells you which ids changed. ``/v0/updates`` returns recently-changed item ids
directly and ``/v0/maxitem`` is a monotonic high-water mark, so "what's new"
needs no ETag, no time window on the request, and no diffing on our side.

If landing this had required the sync loop or the ingestor to grow an
``if provider == …``, the cursor abstraction would have been RSS-shaped and the
right response would have been to fix the contract here — before Slack, whose
shape differs again. It did not: the whole provider difference lives in
``state`` and in this file.

One stream (``updates``), because HN has no per-channel partition — which is
itself useful, since it proves the per-stream machinery tolerates a source with
exactly one.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Optional

import httpx

from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest import http
from flow_sdk.ingest.driver import IngestDriver, FetchResult, SegmentCursorView, SegmentRef
from flow_sdk.ingest.health import SourceError

_BASE = "https://hacker-news.firebaseio.com/v0"
#: Items hydrated per run — a bound on work per tick, with no sleeping.
#: Honest about what it costs: `/v0/updates` returns the *most recent* changed
#: ids and we take the newest slice, so a persistently larger changed set means
#: the tail is never hydrated. That is a deliberate ceiling, not a queue that
#: drains — HN offers no server-side type filter to narrow it.
_MAX_ITEMS_PER_RUN = 60
STREAM_KEY = "updates"


class HackerNewsDriver(IngestDriver):
    provider = "hackernews"
    kind = "datasource.api.hackernews"
    record_kind = "content.feed.item"

    async def segments(self, source) -> list[SegmentRef]:
        return [SegmentRef(key=STREAM_KEY, label="Hacker News updates")]

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        config = source.config or {}
        allowed_types = set(config.get("types") or ["story"])
        min_score = int(config.get("min_score") or 0)
        # Overridable so a self-hosted mirror (or a test's local server) can be
        # pointed at. Ordinary config, not a test seam.
        base = str(config.get("base_url") or _BASE).rstrip("/")

        async with http.client() as client:
            changed_ids = await self._changed_ids(client, base)
            if not changed_ids:
                return FetchResult(
                    items=[], next_state=dict(cursor.state or {}), unchanged=True
                )

            ids = changed_ids[:_MAX_ITEMS_PER_RUN]
            raw_items = await asyncio.gather(
                *(self._item(client, base, i) for i in ids), return_exceptions=True
            )

        items: list[SourceItemSpec] = []
        newest: Optional[datetime] = None
        for raw in raw_items:
            if isinstance(raw, BaseException) or not isinstance(raw, dict):
                continue
            if raw.get("type") not in allowed_types:
                continue
            # HN reports withdrawal explicitly, but phase 1 does not model
            # tombstones — skip rather than pretend.
            if raw.get("deleted") or raw.get("dead"):
                continue
            if min_score and int(raw.get("score") or 0) < min_score:
                continue

            when = _epoch_to_dt(raw.get("time"))
            if when is not None and (newest is None or when > newest):
                newest = when
            items.append(
                SourceItemSpec(
                    data_source_id=source.id,
                    provider=self.provider,
                    kind=self.record_kind,
                    segment_key=cursor.segment_key,
                    segment_label="Hacker News",
                    external_id=str(raw.get("id")),
                    name=str(raw.get("title") or ""),
                    body=str(raw.get("text") or raw.get("url") or ""),
                    occurred_at=when.isoformat() if when else None,
                    author_external_id=raw.get("by"),
                    author_display=raw.get("by"),
                    permalink=f"https://news.ycombinator.com/item?id={raw.get('id')}",
                    # `score` and `kids` live here on purpose: they move
                    # constantly and must not participate in the digest.
                    raw=raw,
                )
            )

        # The high-water pointer is bookkeeping, not a filter: `/v0/updates`
        # returns items that *changed*, which legitimately includes old ones
        # being edited, so filtering by id would drop real updates. Re-seeing an
        # unchanged item is already free — the digest gate absorbs it.
        next_state = dict(cursor.state or {})
        next_state["last_update_ptr"] = max(ids)

        return FetchResult(
            items=items,
            next_state=next_state,
            high_water=newest.isoformat() if newest else None,
        )

    async def _changed_ids(self, client: httpx.AsyncClient, base: str) -> list[int]:
        payload = await self._get_json(client, f"{base}/updates.json")
        if not isinstance(payload, dict):
            return []
        out: list[int] = []
        for raw in payload.get("items") or []:
            try:
                out.append(int(raw))
            except (TypeError, ValueError):
                continue
        return out

    async def _item(self, client: httpx.AsyncClient, base: str, item_id: int) -> Optional[dict]:
        return await self._get_json(client, f"{base}/item/{item_id}.json")

    async def _get_json(self, client: httpx.AsyncClient, url: str):
        response = await http.get(client, url)
        try:
            return response.json()
        except ValueError as exc:
            raise SourceError.transient("bad_json", str(exc)) from exc


def _epoch_to_dt(value) -> Optional[datetime]:
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None
