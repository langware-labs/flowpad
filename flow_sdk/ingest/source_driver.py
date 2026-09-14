"""``SourceDriver`` — a contract source (``flow_sdk.sources``) presented to the sync engine.

DELETE_AT: D1. The in-branch bridge that lets each provider be rewritten as a ``Source``
class, one commit at a time, while the proven engine keeps running unchanged. It is the only
reader of the contract protocols inside ``flow_sdk/ingest/``; the engine swap deletes it
together with ``IngestDriver``, and ``tests/unit/test_sources/test_bridge_is_temporary.py``
flips from asserting it exists to asserting it is gone.

What it translates, and nothing else:

* a ``DataSource`` row → the ``SourceBinding`` the class is constructed from, with the
  provider's credentials (``credentials``) and, for a send, the persona the row posts as;
* ``segments`` → the source's own segments (``Segmented``), else one ``root`` segment;
* ``fetch`` → a traversal of the segment's query, capped by ``pages_per_pass``. With no durable
  cursor yet, a message query starts at the row's window (``since``). Records older than the
  window are dropped — the window is the application's, never the source's — the rest lower to
  the flat envelope (``legacy_lift.envelope_of``) in the order they happened. A reflecting
  source's files become refs, diffed against the manifest the cursor carries: an observed stamp
  per key (``Payload.stable_dump``) and, when the source can say, a handle that survives a rename
  (``StableHandle``), so a moved file is never reported as removed;
* ``send`` → ``Messaging.send``, with the legacy arguments mapped into the channel's addressing
  by ``outgoing``; a refused message is a ``ValueError``, never source health;
* ``verify`` / ``choices`` → ``Verifiable`` / ``Choosing``; after a verify that could read, or a
  send, an ``Identified`` source's identities are stamped on the row, once.

A durable source's ``resume_cursor`` is carried in the cursor state (``lift_cursor`` adopts the
state a legacy driver left) and handed back on the next pass; any other source starts every
traversal from the beginning, as the engine expects.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from flow_sdk.ingest.driver import (
    FetchResult,
    IngestDriver,
    SegmentCursorView,
    SegmentRef,
    SendOutcome,
    SetupVerdict,
    identity_stamped,
    stamp_identity,
)
from flow_sdk.ingest.legacy_lift import envelope_of
from flow_sdk.sources.base import Source
from flow_sdk.sources.binding import Persona, SourceBinding
from flow_sdk.sources.credentials import Credentials
from flow_sdk.sources.errors import Rejected, SourceError
from flow_sdk.sources.protocols import Choosing, Identified, Listable, Messaging, Segmented, StableHandle, Verifiable
from flow_sdk.sources.values.items import MessageData
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import ChangePage
from flow_sdk.sources.values.query import MessageQuery
from flow_sdk.utils.serialization import iso_to_utc

logger = logging.getLogger(__name__)

DELETE_AT = "D1"

#: The one segment of a source that does not split its selection.
ROOT_SEGMENT = "root"

_TRAITS = ("stamps_identity", "open_inbound", "identity_config_key", "connection", "attention_poll_seconds", "segment_budget")
_EPOCH = datetime.min.replace(tzinfo=timezone.utc)

#: ``(row) -> Credentials`` — what this provider's source reads with.
CredentialResolver = Callable[[Any], Awaitable[Credentials]]
#: ``(source, *, thread_key, to, text, subject, in_reply_to) -> (MessageData, answered origin | None)``
#: — the legacy send arguments in this channel's addressing; an answered origin makes it a reply.
Outgoing = Callable[..., "tuple[MessageData, Optional[CloudOrigin]]"]


def _when(item: Any) -> Any:
    """The event time an item's payload reports, if any — the window, the order and the
    high-water read it."""
    return getattr(item.data, "sent_at", None) or getattr(item.data, "published_at", None)


def binding_of(row: Any, *, credentials: Optional[Credentials] = None, persona: Optional[Persona] = None) -> SourceBinding:
    credentials = credentials or Credentials()
    # A secret the resolver lifted out of the row never also rides in ``config``.
    config = {k: v for k, v in (getattr(row, "config", None) or {}).items() if k not in credentials.values}
    return SourceBinding(
        source_id=str(getattr(row, "id", "") or ""),
        name=str(getattr(row, "provider", "") or ""),
        account_key=str(getattr(row, "account_key", "") or ""),
        config=config,
        credentials=credentials,
        persona=persona or Persona(),
    )


async def _persona_of(row: Any) -> Persona:
    from flow_sdk.inbox.sender_identity import sender_identity  # noqa: PLC0415

    identity = await sender_identity(row)
    return Persona(name=identity.username, icon=identity.icon_emoji) if identity else Persona()


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
        credentials: Optional[CredentialResolver] = None,
        outgoing: Optional[Outgoing] = None,
        outbound_spec: Optional[Callable[[Any], type]] = None,
        lift_cursor: Optional[Callable[[dict], Optional[str]]] = None,
        choices: Optional[Callable[[Any, str], Awaitable[list]]] = None,
        configure: Optional[Callable[[Any], dict]] = None,
    ) -> None:
        self.source_cls = cls
        self.provider = cls.provider
        self.kind = kind
        self._build = build or cls
        self._ref_for = ref_for
        self._credentials = credentials
        self._outgoing = outgoing
        self._lift_cursor = lift_cursor
        self._configure = configure
        for trait in _TRAITS:
            setattr(self, trait, getattr(cls, trait))
        self.origin_for = origin_for
        self.origin_id_for = origin_id_for
        self.sends = outgoing is not None and issubclass(cls, Messaging)
        if outbound_spec is not None:
            self.outbound_spec = outbound_spec
        if not cls.reflects:
            self.channel_for = lambda row: cls.origin_kind_for(getattr(row, "config", None) or {})
        self.verify = self._verify if issubclass(cls, Verifiable) else None
        # A field whose offer is APPLICATION state (the desks this instance adopted) is answered
        # by the application; one the provider can list is answered by the source.
        self.choices = choices or (self._choices if issubclass(cls, Choosing) else None)

    async def open(self, row: Any, *, persona: bool = False) -> Source:
        """The configured source. A configuration the class refuses is a person's to fix."""
        credentials = await self._credentials(row) if self._credentials else None
        binding = binding_of(row, credentials=credentials, persona=await _persona_of(row) if persona else None)
        if self._configure is not None:
            # Configuration only the application can resolve (the agent that owns a mailbox row).
            binding = binding.model_copy(update={"config": {**binding.config, **self._configure(row)}})
        try:
            return self._build(binding)
        except ValueError as exc:
            raise Rejected(str(exc)) from exc

    async def segments(self, row: Any) -> list[SegmentRef]:
        source = await self.open(row)
        if not isinstance(source, Segmented):
            return [SegmentRef(key=ROOT_SEGMENT)]
        async with source:
            return [SegmentRef(key=ref.key, label=ref.label, stamp=ref.stamp) for ref in await source.segments()]

    async def fetch(self, row: Any, view: SegmentCursorView) -> FetchResult:
        if not issubclass(self.source_cls, Listable):
            # A push-only source (a webhook is its only delivery): a poll cannot return anything.
            return FetchResult(items=[], next_state=dict(view.state or {}), unchanged=True)
        source = await self.open(row)
        cls = type(source)
        async with source:
            segment = None
            if isinstance(source, Segmented):
                segment = next((ref for ref in await source.segments() if ref.key == view.segment_key), None)
            query = segment.query if segment else None
            state = dict(view.state or {})
            cursor = None
            if cls.durable_cursor:
                cursor = state.get("cursor") or (self._lift_cursor(state) if self._lift_cursor else None)
            floor = iso_to_utc(view.window_start) if view.window_start else None
            if cursor is None and floor is not None and isinstance(query, MessageQuery) and query.since is None:
                query = query.model_copy(update={"since": floor})
            items, removed, moved, resume, pages = [], [], [], None, 0
            while True:
                page = await source.fetch(query, cursor=cursor)
                pages += 1
                items.extend(page.items)
                if isinstance(page, ChangePage):
                    removed.extend(page.removed)
                    moved.extend(page.moved)
                    resume = page.resume_cursor or resume
                cursor = page.next_cursor
                if cursor is None or (cls.pages_per_pass is not None and pages >= cls.pages_per_pass):
                    break
            carried = {"cursor": resume} if cls.durable_cursor and resume else {}
            if cls.reflects:
                return self._files(source, view, items, removed, moved, carried)
            return self._records(row, view, segment, items, removed, carried, floor)

    def _records(self, row: Any, view: SegmentCursorView, segment, items, removed, state: dict, floor) -> FetchResult:
        kept = sorted(
            (item for item in items if floor is None or (_when(item) or floor) >= floor),
            key=lambda item: _when(item) or _EPOCH,
        )
        label = segment.label if segment else ""
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

    async def send(
        self,
        row: Any,
        *,
        thread_key: str,
        to: str,
        text: str,
        subject: str = "",
        conversation_id: str = "",
        in_reply_to: str = "",
    ) -> SendOutcome:
        if self._outgoing is None:
            raise NotImplementedError(f"{self.provider} cannot send")
        source = await self.open(row, persona=True)
        data, answered = self._outgoing(source, thread_key=thread_key, to=to, text=text, subject=subject, in_reply_to=in_reply_to)
        try:
            async with source:
                sent = await (source.reply(answered, data) if answered is not None else source.send(data))
        except SourceError as exc:
            # One refused message must never park the channel's ingestion.
            raise ValueError(f"{self.provider} refused the message: {exc}") from exc
        if isinstance(source, Identified):
            await self._stamp(row, source)
        recorded = False if type(source).echoes_sends else await self._record(row, source, sent)
        return SendOutcome(external_id=sent.origin.key, recorded=recorded)

    async def _record(self, row: Any, source: Source, sent: Any) -> bool:
        """Ingest a sent message the provider will never echo back — the only copy there will be,
        and without it a conversation shows only its inbound half. After identity is stamped, so
        the copy reads as ours."""
        from flow_sdk.ingest.ingestor import ingest_items  # noqa: PLC0415

        segment = ROOT_SEGMENT
        if isinstance(source, Segmented):
            refs = await source.segments()
            segment = refs[0].key if len(refs) == 1 else segment
        try:
            await ingest_items([envelope_of(sent, data_source_id=str(row.id), provider=self.provider, segment_key=segment)])
        except Exception:  # noqa: BLE001 — the message IS delivered; bookkeeping must not unsend it
            logger.exception("[ingest] %s sent %s but could not record the copy", self.provider, sent.origin.key)
            return False
        return True

    async def _verify(self, row: Any) -> SetupVerdict:
        try:
            source = await self.open(row)
        except Rejected as exc:
            return SetupVerdict.waiting(str(exc))
        verdict = await source.verify()
        if (verdict.ready or verdict.pending) and isinstance(source, Identified):
            await self._stamp(row, source)
        return SetupVerdict(ready=verdict.ready, detail=verdict.detail, pending=tuple(verdict.pending))

    async def _stamp(self, row: Any, source: Source) -> None:
        """Record who the source reads and posts as, once. The inbox reads it to know "me":
        without it our own posts come back as a stranger's and a listening loop answers itself."""
        if identity_stamped(row):
            return
        try:
            profiles = await source.whoami()  # type: ignore[attr-defined]
            if profiles:
                identities = [p.origin.key for p in profiles] + [p.name for p in profiles if p.name]
                await stamp_identity(row, account_key=profiles[0].name or profiles[0].origin.key, identities=identities)
        except Exception:  # noqa: BLE001 — identity is a nicety; it never fails what asked for it
            logger.debug("[ingest] %s identity stamp failed", self.provider, exc_info=True)

    async def _choices(self, row: Any, field: str) -> list:
        from flow_sdk.schema.data_spec.choice_spec import Choice  # noqa: PLC0415

        async with await self.open(row) as source:
            offered = await source.choices(field)
        return [Choice(**{k: str(entry[k]) for k in ("id", "name", "detail") if entry.get(k)}) for entry in offered]


__all__ = ["DELETE_AT", "ROOT_SEGMENT", "SourceDriver", "binding_of"]
