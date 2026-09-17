"""``CloudEmailSource`` — a mailbox the hub allocates and holds the credential for.

The third mail transport, and what makes it different is not the protocol: there is nothing to
paste. The hub owns the provider credential and allocates the address; the application reaches it
through its agent-mailbox driver family with the ordinary cloud login, so the source takes a
``MailboxTransport`` rather than a credential.

The hub addresses a mailbox by AGENT, never by address (one mailbox per agent), so the agent id is
the segment: immutable, and the thing without which nothing can poll. The channel is the medium —
``email`` — because it is half the thread key, and naming the transport would fork every thread
the day a second transport reads the same mailbox.

Three traps the code respects:

* **The body is the hydrated text, never the list preview.** ``body`` is digested, so a record
  ingested with the preview and later upgraded would rewrite every row and re-fire every trigger.
* **The hub's ``after`` is EXCLUSIVE.** Asking for ``after=<high water>`` drops a message sharing
  that second — permanently. The request is nudged back a second and the watermark (the stamp plus
  the ids seen AT it) filters locally.
* **A hydration failure stops the page.** Advancing past a message never read would lose it; the
  hydrated prefix is returned and the next pass retries the rest.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any, AsyncGenerator, ClassVar, Optional, Protocol

from flow_sdk.sources.base import Source, positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.email import EmailAddressing
from flow_sdk.sources.errors import (
    InvalidCursor,
    NotFound,
    OutcomeUnknown,
    Rejected,
    SourceError,
    SourceUnavailable,
    Unsupported,
)
from flow_sdk.sources.values.items import EmailMessageData, MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage
from flow_sdk.sources.values.query import DataQuery, MessageQuery
from flow_sdk.sources.values.segment import SegmentRef

#: The medium, not the transport.
CHANNEL = "email"
#: Messages per page; the cursor does the rest.
PAGE_LIMIT = 25
#: How far back an exclusive ``after`` is nudged, so the boundary second is never eaten.
BOUNDARY_NUDGE_SECONDS = 1
_MARK = "mark:"


class MailboxTransport(Protocol):
    """An agent's hub mailbox, as the application reaches it. Raises the contract's errors."""

    async def list_messages(self, agent_id: str, **filters: Any) -> dict: ...

    async def get_message(self, agent_id: str, message_id: str) -> dict: ...

    async def send(self, agent_id: str, body: dict) -> dict: ...

    async def reply(self, agent_id: str, message_id: str, body: dict) -> dict: ...


class CloudEmailMessageData(EmailMessageData):
    spec_kind: ClassVar[str] = "ingest.message.email.cloud"
    volatile: ClassVar[frozenset[str]] = frozenset({"raw"})

    raw: Optional[dict] = None


class CloudEmailConfig(SourceConfig):
    """What a cloud_email source is configured with."""

    derived: ClassVar[tuple[str, ...]] = ("agent_id", "mailbox_typeid", "provider_inbox_id")

    address: str = ""
    #: The agent the mailbox serves; ``configure`` fills it from the row's owner.
    agent_id: str = ""
    #: The hub mailbox row and the provider's id for it — the application's, written when the mailbox is allocated.
    mailbox_typeid: str = ""
    provider_inbox_id: str = ""

    @classmethod
    def lift(cls, raw):
        """``inbox_typeid`` is what ``mailbox_typeid`` was called before the agent's address became an
        ``AgentMailbox``; a source written then still carries it."""
        raw = dict(raw)
        retired = raw.pop("inbox_typeid", None)
        if retired and not raw.get("mailbox_typeid"):
            raw["mailbox_typeid"] = retired
        return raw


class CloudEmailSource(EmailAddressing, Source):

    Config = CloudEmailConfig
    provider = "cloud_email"
    origin_kind = CHANNEL
    durable_cursor = True
    page_size = PAGE_LIMIT
    pages_per_pass = 1
    identity_config_key = "agent_id"
    #: Mailbox-grade while watched.
    attention_poll_seconds = 5

    def __init__(self, binding: SourceBinding, mailbox: Optional[MailboxTransport] = None) -> None:
        super().__init__(binding)
        self._mailbox = mailbox

    @classmethod
    def resume_at(cls, high_water: str, boundary_ids: list[str]) -> str:
        return _MARK + json.dumps({"high_water": high_water, "boundary_ids": list(boundary_ids)})

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def build(cls, binding: SourceBinding) -> "CloudEmailSource":
        from .transport import AppMailbox  # noqa: PLC0415

        return cls(binding, mailbox=AppMailbox())

    @classmethod
    def configure(cls, row: Any) -> dict:
        """The agent a mailbox row serves: its config, else the Agent that owns it."""
        from flow_sdk.stream_inbox.projection import agent_id_of  # noqa: PLC0415

        agent = agent_id_of(row)
        return {"agent_id": agent} if agent else {}

    @classmethod
    def lift_cursor(cls, state: dict) -> Optional[str]:
        if state.get("high_water") and state.get("boundary_ids"):
            return cls.resume_at(state["high_water"], state["boundary_ids"])
        return None

    @staticmethod
    def thread_key(agent_id: str, thread_id: str) -> Optional[str]:
        """The provider thread id SCOPED TO THIS MAILBOX. A provider's thread id is mailbox-scoped,
        and every cloud mailbox reports the same channel, so a bare id would let two agents whose
        mailboxes agree on a thread id collapse onto one thread. ``None`` without a thread id, so the
        application falls back to the subject instead of threading strangers onto ``"<agent>:"``."""
        thread_id = str(thread_id or "").strip()
        return f"{agent_id}:{thread_id}" if thread_id else None

    @property
    def mailbox(self) -> MailboxTransport:
        if self._mailbox is None:
            raise SourceUnavailable("no mailbox transport reaches this source")
        return self._mailbox

    @property
    def agent_id(self) -> str:
        agent = str(self.config.get("agent_id") or "").strip()
        if not agent:
            raise Rejected("This mailbox source needs its agent (config.agent_id).")
        return agent

    def origin(self, key: str, *within: str) -> CloudOrigin:
        return super().origin(key, *(within or (self.agent_id,)))

    async def segments(self) -> list[SegmentRef]:
        return [SegmentRef(key=self.agent_id, label=str(self.config.get("address") or "").strip(), query=MessageQuery())]

    # ── read ────────────────────────────────────────────────────────────────
    async def fetch(self, query: Optional[DataQuery] = None, *, cursor: Optional[str] = None, page_size: Optional[int] = None) -> ChangePage:
        self._require_open()
        if query is not None and not isinstance(query, DataQuery):
            raise TypeError(f"expected DataQuery, got {type(query).__name__}")
        if query is not None and (not isinstance(query, MessageQuery) or query.conversation is not None):
            raise Unsupported("a hub mailbox is listed whole; it does not read one thread")
        limit = min(self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE), 100)
        mark = _Mark.decode(cursor, floor=query.since.isoformat() if query is not None and query.since and cursor is None else "")
        # Deliberately no `labels` filter: our own sent copies come back through this very listing,
        # and filtering to `received` would make every reply vanish from its own thread. The nudged
        # `after` re-reads the boundary second, so the request asks for the ids already seen there on
        # top of the page — otherwise a burst sharing a second fills the page and never advances.
        requested = min(limit + len(mark.boundary_ids), 100)
        filters: dict[str, str] = {"limit": str(requested), "ascending": "true"}
        if mark.high_water:
            filters["after"] = _nudge_back(mark.high_water)
        listing = await self.mailbox.list_messages(self.agent_id, **filters)
        messages = listing.get("messages") or []
        items: list[MessageItem] = []
        stopped = False
        for message in messages:
            if len(items) == limit:
                stopped = True
                break
            stamp, message_id = str(message.get("timestamp") or ""), str(message.get("message_id") or "")
            if not message_id or not mark.is_new(stamp, message_id):
                continue
            try:
                full = await self.mailbox.get_message(self.agent_id, message_id)
            except SourceError:
                break  # keep the cursor at the prefix that was read; the next pass retries this one
            items.append(self._item(full or message))
            mark.advance(stamp, message_id)
        token = mark.encode()
        more = bool(items) and (stopped or len(messages) >= requested)
        return ChangePage(
            items=tuple(items),
            next_cursor=token if more else None,
            resume_cursor=token or (cursor if isinstance(cursor, str) and cursor.startswith(_MARK) else None),
        )

    async def iterate(self, query: Optional[DataQuery] = None, *, page_size: Optional[int] = None) -> AsyncGenerator[MessageItem, None]:
        cursor: Optional[str] = None
        while True:
            page = await self.fetch(query, cursor=cursor, page_size=page_size)
            for item in page.items:
                yield item
            if (cursor := page.next_cursor) is None:
                return

    def _item(self, message: dict) -> MessageItem:
        """One hub ``EmailMessage``. ``sender`` arrives structured (``{address, name}``) — the hub
        normalizes it, so nothing here re-parses a header."""
        sender = message.get("sender") or {}
        address = str(sender.get("address") or "")
        thread = self.thread_key(self.agent_id, str(message.get("thread_id") or ""))
        replied = str(message.get("in_reply_to") or "")
        recipients = [
            UserProfile(origin=self.origin(str(r["address"])), name=str(r.get("name") or "") or None, address=str(r["address"]))
            for field in ("to", "cc")
            for r in message.get(field) or []
            if isinstance(r, dict) and r.get("address")
        ]
        data = CloudEmailMessageData(
            subject=str(message.get("subject") or "") or None,
            text=_body_of(message) or None,
            conversation=self.origin(thread) if thread else None,
            sender=UserProfile(origin=self.origin(address), name=str(sender.get("name") or "") or address, address=address) if address else None,
            sent_at=_when(message.get("timestamp")),
            in_reply_to=self.origin(replied) if replied else None,
            recipients=tuple(recipients),
            raw=message,
        )
        return MessageItem(origin=self.origin(str(message["message_id"])), data=data)

    # ── send ────────────────────────────────────────────────────────────────
    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if (data.conversation is None) == (not data.recipients):
            raise ValueError("address exactly one of a conversation or recipients")
        if data.conversation is not None:
            latest = await self._latest_in(self._key_of(data.conversation))
            return await self.reply_as(latest, data, data.conversation)
        if len(data.recipients) != 1:
            raise Unsupported("a hub mailbox send has exactly one recipient")
        body: dict[str, Any] = {"to": data.recipients[0].address or data.recipients[0].origin.key, "text": data.text}
        if getattr(data, "subject", None):
            body["subject"] = data.subject
        return self._sent(await self.mailbox.send(self.agent_id, body), data, None)

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        return await self.reply_as(origin, data, None)

    async def reply_as(self, answered: CloudOrigin, data: MessageData, conversation: Optional[CloudOrigin]) -> MessageItem:
        sent = self._sent(await self.mailbox.reply(self.agent_id, self._key_of(answered), {"text": data.text}), data, conversation)
        return MessageItem(origin=sent.origin, data=sent.data.model_copy(update={"in_reply_to": answered}))

    def _sent(self, body: dict, data: MessageData, conversation: Optional[CloudOrigin]) -> MessageItem:
        message_id = str((body or {}).get("message_id") or "")
        if not message_id:
            raise OutcomeUnknown("the hub accepted the message but returned no id for it")
        thread = self.thread_key(self.agent_id, str((body or {}).get("thread_id") or ""))
        sent = EmailMessageData(
            text=data.text, subject=getattr(data, "subject", None), conversation=conversation or (self.origin(thread) if thread else None)
        )
        return MessageItem(origin=self.origin(message_id), data=sent)

    async def _latest_in(self, thread_key: str) -> CloudOrigin:
        """Email continues a thread by replying: the newest message in it is what a thread send answers."""
        listing = await self.mailbox.list_messages(self.agent_id, limit="100")
        in_thread = [
            m for m in listing.get("messages") or []
            if m.get("message_id") and self.thread_key(self.agent_id, str(m.get("thread_id") or "")) == thread_key
        ]
        if not in_thread:
            raise NotFound(f"no message in thread {thread_key} to continue")
        return self.origin(str(max(in_thread, key=lambda m: str(m.get("timestamp") or ""))["message_id"]))

    def _key_of(self, origin: object) -> str:
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        if origin != self.origin(origin.key):
            raise ValueError(f"{origin!r} is outside this source's scope")
        return origin.key


class _Mark:
    def __init__(self, high_water: str = "", boundary_ids: Optional[list[str]] = None) -> None:
        self.high_water, self.boundary_ids = high_water, list(boundary_ids or [])

    @classmethod
    def decode(cls, cursor: object, *, floor: str = "") -> "_Mark":
        if cursor is None:
            return cls(floor)
        if not isinstance(cursor, str):
            raise TypeError(f"cursor must be a string, got {type(cursor).__name__}")
        try:
            state = json.loads(cursor[len(_MARK):]) if cursor.startswith(_MARK) else None
        except ValueError:
            state = None
        if not isinstance(state, dict) or not isinstance(state.get("high_water"), str):
            raise InvalidCursor("not a mailbox cursor")
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
        return CloudEmailSource.resume_at(self.high_water, self.boundary_ids) if self.high_water and self.boundary_ids else None


def _body_of(message: dict) -> str:
    """The body by ONE deterministic rule — ``text``, else the html, never the preview — because a
    body that depended on which call populated it would flip the digest on the next poll."""
    return str(message.get("text") or "").strip() or str(message.get("html") or "").strip()


def _nudge_back(iso: str) -> str:
    """``iso`` minus a second; unparseable input is sent as-is, because over-fetching is the safe
    direction."""
    parsed = _when(iso)
    return (parsed - timedelta(seconds=BOUNDARY_NUDGE_SECONDS)).isoformat() if parsed else iso


def _when(value: Any) -> Optional[datetime]:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00")) if value else None
    except ValueError:
        return None
    return parsed if parsed is None or parsed.tzinfo else None


def _check_outgoing(data: object) -> None:
    if not isinstance(data, MessageData):
        raise TypeError(f"expected MessageData, got {type(data).__name__}")
    if not (data.text or "").strip():
        raise ValueError("a mailbox message needs text")
    if data.sender is not None or data.in_reply_to is not None or data.sent_at is not None or data.attachments:
        raise ValueError("sender, in_reply_to, sent_at and attachments are assigned by the provider")


__all__ = ["BOUNDARY_NUDGE_SECONDS", "CHANNEL", "PAGE_LIMIT", "CloudEmailMessageData", "CloudEmailSource", "MailboxTransport"]
