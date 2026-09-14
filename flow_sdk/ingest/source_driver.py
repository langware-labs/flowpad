"""``SourceDriver`` — a contract source (``flow_sdk.sources``) presented to the sync engine.

DELETE_AT: D1. The in-branch bridge that lets each provider be rewritten as a ``Source``
class, one commit at a time, while the proven engine keeps running unchanged. It is the only
reader of the contract protocols inside ``flow_sdk/ingest/``; the engine swap deletes it
together with ``IngestDriver``, and ``tests/unit/test_sources/test_bridge_is_temporary.py``
flips from asserting it exists to asserting it is gone.

What it translates, and nothing else:

* a ``DataSource`` row → the ``SourceBinding`` the class is constructed from;
* ``segments`` → the source's own segments (``Segmented``), else one ``root`` segment;
* ``fetch`` → one full traversal of the segment's query. Records older than the row's window
  are dropped — the window is the application's, never the source's — and the rest lower to
  the flat envelope (``legacy_lift.envelope_of``); a reflecting source's files become refs, diffed against the
  manifest the cursor carries — an observed stamp per key (``Payload.stable_dump``) and, when
  the source can say, a handle that survives a rename (``StableHandle``), so a moved file is
  never reported as removed;
* ``verify`` / ``choices`` → the ``Verifiable`` / ``Choosing`` capabilities.

A durable source's ``resume_cursor`` is carried in the cursor state and handed back on the
next pass; any other source starts every traversal from the beginning, as the engine expects.
"""
from __future__ import annotations

from typing import Any, Callable, Optional

from flow_sdk.ingest.driver import FetchResult, IngestDriver, SegmentCursorView, SegmentRef, SetupVerdict
from flow_sdk.ingest.legacy_lift import envelope_of
from flow_sdk.sources.base import Source
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import Rejected
from flow_sdk.sources.protocols import Choosing, Segmented, StableHandle, Verifiable
from flow_sdk.sources.values.page import ChangePage
from flow_sdk.utils.serialization import iso_to_utc

DELETE_AT = "D1"

#: The one segment of a source that does not split its selection.
ROOT_SEGMENT = "root"

_TRAITS = ("stamps_identity", "open_inbound", "identity_config_key", "connection", "attention_poll_seconds", "segment_budget")


def _when(item: Any) -> Any:
    """The event time an item's payload reports, if any — the window and the high-water read it."""
    return getattr(item.data, "sent_at", None) or getattr(item.data, "published_at", None)


def binding_of(row: Any) -> SourceBinding:
    return SourceBinding(
        source_id=str(getattr(row, "id", "") or ""),
        name=str(getattr(row, "provider", "") or ""),
        account_key=str(getattr(row, "account_key", "") or ""),
        config=dict(getattr(row, "config", None) or {}),
    )


class SourceDriver(IngestDriver):
    def __init__(
        self,
        cls: type[Source],
        *,
        kind: str,
        build: Optional[Callable[[SourceBinding], Source]] = None,
        ref_for: Optional[Callable[[Source, str], str]] = None,
        origin_for: Optional[Callable[..., Any]] = None,
        origin_id_for: Optional[Callable[..., str]] = None,
    ) -> None:
        self.source_cls = cls
        self.provider = cls.provider
        self.kind = kind
        self._build = build or cls
        self._ref_for = ref_for
        for trait in _TRAITS:
            setattr(self, trait, getattr(cls, trait))
        self.origin_for = origin_for
        self.origin_id_for = origin_id_for
        if not cls.reflects:
            self.channel_for = lambda row: cls.origin_kind_for(getattr(row, "config", None) or {})
        self.verify = self._verify if issubclass(cls, Verifiable) else None
        self.choices = self._choices if issubclass(cls, Choosing) else None

    def open(self, row: Any) -> Source:
        """The configured source. A configuration the class refuses is a person's to fix."""
        try:
            return self._build(binding_of(row))
        except ValueError as exc:
            raise Rejected(str(exc)) from exc

    async def segments(self, row: Any) -> list[SegmentRef]:
        source = self.open(row)
        if not isinstance(source, Segmented):
            return [SegmentRef(key=ROOT_SEGMENT)]
        async with source:
            return [SegmentRef(key=ref.key, label=ref.label, stamp=ref.stamp) for ref in await source.segments()]

    async def fetch(self, row: Any, view: SegmentCursorView) -> FetchResult:
        source = self.open(row)
        async with source:
            segment = None
            if isinstance(source, Segmented):
                segment = next((ref for ref in await source.segments() if ref.key == view.segment_key), None)
            durable = type(source).durable_cursor
            cursor = (view.state or {}).get("cursor") if durable else None
            items, removed, moved, resume = [], [], [], None
            while True:
                page = await source.fetch(segment.query if segment else None, cursor=cursor)
                items.extend(page.items)
                if isinstance(page, ChangePage):
                    removed.extend(page.removed)
                    moved.extend(page.moved)
                    resume = page.resume_cursor or resume
                if (cursor := page.next_cursor) is None:
                    break
            state = {"cursor": resume} if durable and resume else {}
            if type(source).reflects:
                return self._files(source, view, items, removed, moved, state)
            label = segment.label if segment else ""
            floor = iso_to_utc(view.window_start) if view.window_start else None
            kept = [item for item in items if floor is None or (_when(item) or floor) >= floor]
            envelopes = [
                envelope_of(item, data_source_id=str(row.id), provider=self.provider, segment_key=view.segment_key, segment_label=label)
                for item in kept
            ]
            stamps = [when for when in map(_when, kept) if when is not None]
            return FetchResult(
                items=envelopes,
                next_state=state,
                high_water=max(stamps).isoformat() if stamps else None,
                unchanged=not envelopes and not removed,
            )

    def _files(self, source: Source, view: SegmentCursorView, items, removed, moved, state: dict) -> FetchResult:
        assert self._ref_for is not None, f"{self.provider} reflects but names no ref_for"
        handle_of = source.handle_of if isinstance(source, StableHandle) else (lambda _item: "")
        current = {item.origin.key: [item.data.stable_dump(), handle_of(item)] for item in items}
        previous = dict((view.state or {}).get("manifest") or {})
        changed = [key for key, entry in current.items() if previous.get(key) != entry]
        live = {entry[1] for entry in current.values() if entry[1]}
        gone = [key for key, entry in previous.items() if key not in current and not (entry[1] and entry[1] in live)]
        gone.extend(origin.key for origin in removed)
        ref = lambda key: self._ref_for(source, key)  # noqa: E731
        return FetchResult(
            refs=[ref(key) for key in changed],
            tombstones=[ref(key) for key in dict.fromkeys(gone)],
            renames={ref(move.origin.key): ref(move.previous.key) for move in moved},
            next_state={**state, "manifest": current},
            high_water=str(len(current)),
            unchanged=not changed and not gone and not moved,
        )

    async def _verify(self, row: Any) -> SetupVerdict:
        try:
            source = self.open(row)
        except Rejected as exc:
            return SetupVerdict.waiting(str(exc))
        verdict = await source.verify()
        return SetupVerdict(ready=verdict.ready, detail=verdict.detail, pending=tuple(verdict.pending))

    async def _choices(self, row: Any, field: str) -> list:
        from flow_sdk.schema.data_spec.choice_spec import Choice  # noqa: PLC0415

        async with self.open(row) as source:
            offered = await source.choices(field)
        return [Choice(**{k: str(entry[k]) for k in ("id", "name", "detail") if entry.get(k)}) for entry in offered]


__all__ = ["DELETE_AT", "ROOT_SEGMENT", "SourceDriver", "binding_of"]
