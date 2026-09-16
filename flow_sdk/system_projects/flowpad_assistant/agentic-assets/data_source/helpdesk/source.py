"""``HelpdeskSource`` — a hub desk's tickets as a message source.

A ticket is a hub conversation (``kind=helpdesk``): a guest opens it against a desk project, staff
*pick it up* to join, and every reply is an ordinary hub message the hub masks to the desk's
brand. The pool is the segment list, a ticket's messages are the records, a reply is ``send``.

**Both writers, one row.** A ticket's messages also reach this machine through the hub mirror
once the owner is a participant, so every record carries the hub's own ids
(``hub_conversation_id`` / ``hub_message_id``): the application adopts the mirrored rows instead
of minting twins.

**The hub is Flowpad's own backend, reached through a transport.** Its auth, token refresh and
local-privacy gate belong to whoever holds the login, so the source takes a ``HubTransport``
rather than a credential: the application passes the one it already has; a source host hands over
its backend's. Without one, every call is ``SourceUnavailable``.

**No ``since`` on the hub's messages.** The cursor is a watermark on ``updated_date`` plus the ids
seen AT it (a burst can share a second); an edited message re-arrives because its stamp moved.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, ClassVar, Optional, Protocol

from flow_sdk.sources.base import Source, positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import InvalidCursor, NotFound, OutcomeUnknown, Rejected, SourceUnavailable, Unsupported
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage
from flow_sdk.sources.values.query import DataQuery, MessageQuery
from flow_sdk.sources.values.segment import SegmentRef

#: The channel a ticket is: half the thread key, so it names what a ticket IS.
CHANNEL = "helpdesk"
_MARK = "mark:"


class HubTransport(Protocol):
    """The Flowpad hub, as whoever holds the login reaches it. Raises the contract's errors."""

    async def get(self, entity_type: str, entity_id: str, action: str) -> Any: ...

    async def post(self, entity_type: str, payload: dict, entity_id: str, action: str) -> Any: ...

    def me(self) -> str:
        """The signed-in hub user id, or ``""`` when signed out."""
        ...


class HelpdeskMessageData(MessageData):
    spec_kind: ClassVar[str] = "ingest.message.helpdesk"
    volatile: ClassVar[frozenset[str]] = frozenset({"raw"})

    #: The hub conversation this ticket message lives in, for adoption.
    hub_conversation_id: Optional[str] = None
    #: The hub's own id for the message, for adoption.
    hub_message_id: Optional[str] = None
    raw: Optional[dict] = None


class HelpdeskSource(Source):
    provider = "helpdesk"
    origin_kind = CHANNEL
    durable_cursor = True
    #: Strangers are the point: an empty allowlist admits every requester.
    open_inbound = True
    identity_config_key = "desk_project_id"
    #: Chat-grade while watched.
    attention_poll_seconds = 5

    def __init__(self, binding: SourceBinding, hub: Optional[HubTransport] = None) -> None:
        super().__init__(binding)
        self._hub = hub

    @classmethod
    def resume_at(cls, high_water: str, boundary_ids: list[str]) -> str:
        """The cursor that continues after the messages stamped ``high_water`` with these ids."""
        return _MARK + json.dumps({"high_water": high_water, "boundary_ids": list(boundary_ids)})

    @property
    def hub(self) -> HubTransport:
        if self._hub is None:
            raise SourceUnavailable("no hub transport reaches this source")
        return self._hub

    @property
    def desk(self) -> str:
        return str(self.config.get("desk_project_id") or "").strip()

    def origin(self, key: str, *within: str) -> CloudOrigin:
        return super().origin(key, *(within or (self.desk or CHANNEL,)))

    def ticket_origin(self, ticket: str) -> CloudOrigin:
        return self.origin(ticket, ticket)

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def build(cls, binding: SourceBinding) -> "HelpdeskSource":
        from .transport import AppHub  # noqa: PLC0415

        return cls(binding, hub=AppHub())

    @classmethod
    def lift_cursor(cls, state: dict) -> Optional[str]:
        return cls.resume_at(state["high_water"], state.get("boundary_ids") or []) if state.get("high_water") else None

    @classmethod
    def outbound_spec(cls) -> type:
        from flow_sdk.builtin.source_item import HelpdeskMessageSpec  # noqa: PLC0415

        return HelpdeskMessageSpec

    def message_for(self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""):
        """A reply goes to the TICKET — the hub conversation id — which the hub threads by."""
        ticket = str(to or "").strip() or str(thread_key or "").strip()
        if not ticket:
            raise ValueError("a help-desk reply needs the ticket's conversation id")
        return MessageData(text=text, conversation=self.ticket_origin(ticket)), None

    @classmethod
    async def choices_for(cls, row: Any, field: str) -> list:
        """The desks this login can reach: the deployment's default desk and every desk adopted into a
        local project. Application state, not the hub's — so it is read from the application. Typing
        an id still works."""
        from flow_sdk.app.actions.flow_message_action import resolve_helpdesk  # noqa: PLC0415
        from flow_sdk.builtin.helpdesk import Helpdesk  # noqa: PLC0415
        from flow_sdk.schema.data_spec.choice_spec import Choice  # noqa: PLC0415

        if field != "desk_project_id":
            return []
        out: list = []
        default = await resolve_helpdesk()
        if default is not None:
            out.append(Choice(id=default.project_id, name="Flowpad Support", detail="the deployment's default desk"))
        try:
            desks = await Helpdesk.get_all({})
        except Exception:  # noqa: BLE001 — no adopted desks is not a failure
            desks = []
        for desk in desks or []:
            queue = str(getattr(desk, "desk_project_id", "") or "").strip()
            if queue and all(c.id != queue for c in out):
                out.append(Choice(id=queue, name=str(getattr(desk, "display_name", "") or queue), detail="adopted desk"))
        return out

    # ── the pool ────────────────────────────────────────────────────────────
    async def segments(self) -> list[SegmentRef]:
        """One segment per ticket in the pool, picked up or not, newest activity first. The pool
        row says whether a ticket moved (``message_count:updated_at``), so an idle ticket costs no
        fetch and a moved one is never queued behind idle ones."""
        if not self.desk:
            raise Rejected("This help-desk source needs its desk (config.desk_project_id).")
        rows = _rows_of(await self.hub.get("project", self.desk, "helpdesk_conversations"))
        refs = []
        for row in sorted(rows, key=lambda r: str(r.get("updated_at") or ""), reverse=True):
            ticket = str(row.get("conversation_id") or "").strip()
            if not ticket:
                continue
            label = str(row.get("title") or row.get("preview") or "").strip()[:80] or ticket
            stamp = f"{row.get('message_count') or 0}:{row.get('updated_at') or ''}"
            refs.append(SegmentRef(key=ticket, label=label, stamp=stamp, query=MessageQuery(conversation=self.ticket_origin(ticket))))
        return refs

    # ── read: one ticket ────────────────────────────────────────────────────
    async def fetch(self, query: Optional[DataQuery] = None, *, cursor: Optional[str] = None, page_size: Optional[int] = None) -> ChangePage:
        self._require_open()
        if query is not None and not isinstance(query, DataQuery):
            raise TypeError(f"expected DataQuery, got {type(query).__name__}")
        if query is not None and not isinstance(query, MessageQuery):
            raise Unsupported(f"HelpdeskSource does not support {type(query).__name__}")
        limit = self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        mark = _Mark.decode(cursor)
        if query is None or query.conversation is None:
            return ChangePage(items=())  # a desk has no default ticket: name one
        ticket = self._ticket_of(query.conversation)
        children = _rows_of(await self.hub.get("conversation", ticket, "flow_message"))
        fresh = [fm for fm in sorted(children, key=_stamp_of) if str(fm.get("id") or "").strip() and mark.is_new(_stamp_of(fm), str(fm["id"]).strip())]
        page = fresh[:limit]
        for fm in page:
            mark.advance(_stamp_of(fm), str(fm["id"]).strip())
        token = mark.encode()
        return ChangePage(
            items=tuple(self._item(ticket, fm) for fm in page),
            next_cursor=token if len(fresh) > limit else None,
            resume_cursor=token or cursor,
        )

    async def iterate(self, query: Optional[DataQuery] = None, *, page_size: Optional[int] = None) -> AsyncGenerator[MessageItem, None]:
        cursor: Optional[str] = None
        while True:
            page = await self.fetch(query, cursor=cursor, page_size=page_size)
            for item in page.items:
                yield item
            if (cursor := page.next_cursor) is None:
                return

    def _item(self, ticket: str, fm: dict) -> MessageItem:
        fm_id, sender = str(fm["id"]).strip(), str(fm.get("sender_id") or "").strip()
        data = HelpdeskMessageData(
            text=str(fm.get("text") or ""),
            conversation=self.ticket_origin(ticket),
            sender=UserProfile(origin=self.origin(sender, ticket), name=str(fm.get("sender_name") or "") or sender) if sender else None,
            sent_at=_when(fm.get("created_date")),
            hub_conversation_id=ticket,
            hub_message_id=fm_id,
            raw=fm,
        )
        return MessageItem(origin=self.origin(fm_id, ticket), data=data)

    # ── identity ────────────────────────────────────────────────────────────
    async def whoami(self) -> tuple[UserProfile, ...]:
        me = self.hub.me()
        return (UserProfile(origin=CloudOrigin(kind=CHANNEL, namespace="hub-users", key=me)),) if me else ()

    # ── send: pick up, then answer ──────────────────────────────────────────
    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if (data.conversation is None) == (not data.recipients):
            raise ValueError("address exactly one of a conversation or recipients")
        if data.conversation is None:
            raise Unsupported("a desk answers tickets; it cannot open one to a person")
        return await self._answer(self._ticket_of(data.conversation), data.text or "", None)

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        ticket, message = self._where(origin)
        if message is None:
            raise NotFound(f"{origin!r} names no ticket message", origin=origin)
        return await self._answer(ticket, data.text or "", origin)

    async def _answer(self, ticket: str, text: str, answered: Optional[CloudOrigin]) -> MessageItem:
        """Pick the ticket up, then post. The hub fans a ticket out to participants only, so pickup is
        what makes the answer (and the guest's next word) reach this machine; the hub makes a second
        pickup a no-op, so it is always sent rather than paid for with a read first."""
        await self.hub.post("conversation", {}, ticket, "pickup")
        body = await self.hub.post("conversation", {"text": text, "conversation_id": ticket}, ticket, "add_message")
        message_id = str((body or {}).get("id") or "")
        if not message_id:
            raise OutcomeUnknown("the hub accepted the reply but returned no id for it")
        data = MessageData(text=text, conversation=self.ticket_origin(ticket), sent_at=datetime.now(timezone.utc), in_reply_to=answered)
        return MessageItem(origin=self.origin(message_id, ticket), data=data)

    # ── transport ───────────────────────────────────────────────────────────
    def _where(self, origin: object) -> tuple[str, Optional[str]]:
        """``(ticket, message id)``; the message is ``None`` for the ticket itself."""
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        account = self.binding.account_key
        prefix = f"{account}/" if account else ""
        ticket = origin.namespace[len(prefix):] if origin.kind == self._scope.kind and origin.namespace.startswith(prefix) else ""
        if not ticket or "/" in ticket:
            raise ValueError(f"{origin!r} is outside this source's scope")
        if ticket in (self.desk, CHANNEL):
            return ticket, None
        return ticket, None if origin.key == ticket else origin.key

    def _ticket_of(self, origin: object) -> str:
        ticket, message = self._where(origin)
        if ticket in (self.desk, CHANNEL) or message is not None:
            raise NotFound(f"{origin!r} is not a ticket on this desk")
        return ticket


class _Mark:
    """A high-water stamp plus the ids seen AT it. Walk ascending: ``is_new`` answers, ``advance``
    moves the mark."""

    def __init__(self, high_water: str = "", boundary_ids: Optional[list[str]] = None) -> None:
        self.high_water, self.boundary_ids = high_water, list(boundary_ids or [])

    @classmethod
    def decode(cls, cursor: object) -> "_Mark":
        if cursor is None:
            return cls()
        if not isinstance(cursor, str):
            raise TypeError(f"cursor must be a string, got {type(cursor).__name__}")
        try:
            state = json.loads(cursor[len(_MARK):]) if cursor.startswith(_MARK) else None
        except ValueError:
            state = None
        if not isinstance(state, dict) or not isinstance(state.get("high_water"), str):
            raise InvalidCursor("not a help-desk cursor")
        return cls(state["high_water"], [str(i) for i in state.get("boundary_ids") or []])

    def is_new(self, stamp: str, entry_id: str) -> bool:
        if not (stamp and self.high_water):
            return True
        return stamp > self.high_water or (stamp == self.high_water and entry_id not in self.boundary_ids)

    def advance(self, stamp: str, entry_id: str) -> None:
        if stamp > self.high_water:
            self.high_water, self.boundary_ids = stamp, [entry_id]
        elif stamp == self.high_water:
            self.boundary_ids.append(entry_id)

    def encode(self) -> Optional[str]:
        return HelpdeskSource.resume_at(self.high_water, self.boundary_ids) if self.high_water else None


def _rows_of(payload: Any) -> list[dict]:
    """A hub list answer: a bare list, or a dict wrapping one under ``data``/``items``/``results``."""
    if isinstance(payload, dict):
        payload = next((v for k in ("data", "items", "results") if isinstance((v := payload.get(k)), list)), [])
    return [row for row in payload if isinstance(row, dict)] if isinstance(payload, list) else []


def _stamp_of(fm: dict) -> str:
    return str(fm.get("updated_date") or fm.get("created_date") or "")


def _when(value: Any) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")) if value else None
    except ValueError:
        return None


def _check_outgoing(data: object) -> None:
    if not isinstance(data, MessageData):
        raise TypeError(f"expected MessageData, got {type(data).__name__}")
    if not (data.text or "").strip():
        raise ValueError("a help-desk reply needs text")
    if data.sender is not None or data.in_reply_to is not None or data.sent_at is not None or data.attachments:
        raise ValueError("sender, in_reply_to, sent_at and attachments are assigned by the provider")


__all__ = ["CHANNEL", "HelpdeskMessageData", "HelpdeskSource", "HubTransport"]
