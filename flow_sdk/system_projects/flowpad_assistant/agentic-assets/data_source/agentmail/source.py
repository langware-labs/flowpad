"""``AgentMailSource`` — a mailbox the agent owns, over AgentMail's REST API.

The transport that can SEND: the harness's Gmail connector exposes drafts and no send verb, so a
reply through it stops as a draft. Everything above this source — the digest, identity, the inbox
projection, threading — is shared with every other mail channel.

Email continues a thread by replying to a message in it, so a conversation-addressed send replies
to the thread's latest message; a recipient-addressed send starts a new thread. The sent copy
comes back through the same listing, so it is never recorded here.
"""
from __future__ import annotations

from datetime import datetime
from email.utils import getaddresses, parseaddr
from typing import Any, AsyncGenerator, Optional
from urllib.parse import quote

from flow_sdk.sources import http
from flow_sdk.sources.base import Source, positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.email import EmailAddressing
from flow_sdk.sources.errors import AccessDenied, InvalidCursor, NotFound, OutcomeUnknown, Rejected, Unsupported
from flow_sdk.sources.values.items import EmailMessageData, MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage
from flow_sdk.sources.values.query import DataQuery, MessageQuery
from flow_sdk.sources.values.segment import SegmentRef

DEFAULT_BASE_URL = "https://api.agentmail.to/v0"
#: Messages per page; the resume cursor does the rest.
PAGE_LIMIT = 25
#: AgentMail's own ceiling for one round-trip — never a retry budget.
REQUEST_TIMEOUT_SECONDS = 30
#: Where the application keeps the key: a MACHINE secret, because the inbox is account-bound and an
#: ingest source has no project to hold a project-scoped credential.
SECRET_NAME = "ingest_api.agentmail"

_RESUME = "resume:"
_PAGE = "page:"


class AgentMailSource(EmailAddressing, Source):
    provider = "agentmail"
    durable_cursor = True
    page_size = PAGE_LIMIT
    pages_per_pass = 1

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._client: Any = None

    @classmethod
    def resume_after(cls, timestamp: str) -> str:
        return _RESUME + timestamp

    @classmethod
    def lift_cursor(cls, state: dict) -> Optional[str]:
        return cls.resume_after(state["high_water"]) if state.get("high_water") else None

    @property
    def inbox(self) -> str:
        inbox = str(self.config.get("inbox") or "").strip()
        if not inbox:
            raise Rejected("This AgentMail source needs its inbox (config.inbox).")
        return inbox

    @property
    def base_url(self) -> str:
        return str(self.config.get("base_url") or DEFAULT_BASE_URL).rstrip("/")

    def origin(self, key: str, *within: str) -> CloudOrigin:
        return super().origin(key, *(within or (self.inbox,)))

    async def _open(self) -> None:
        self._client = http.client(REQUEST_TIMEOUT_SECONDS)

    async def _close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def segments(self) -> list[SegmentRef]:
        return [SegmentRef(key=self.inbox, label=self.inbox, query=MessageQuery())]

    # ── read ────────────────────────────────────────────────────────────────
    async def fetch(self, query: Optional[DataQuery] = None, *, cursor: Optional[str] = None, page_size: Optional[int] = None) -> ChangePage:
        self._require_open()
        if query is not None and not isinstance(query, DataQuery):
            raise TypeError(f"expected DataQuery, got {type(query).__name__}")
        if query is not None and (not isinstance(query, MessageQuery) or query.conversation is not None):
            raise Unsupported("AgentMail lists an inbox; it does not read one thread")
        limit = self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        floor, newest, token = _start(query, cursor)
        params: dict[str, Any] = {"limit": limit}
        if token:
            params["page_token"] = token
        body = await self._api("GET", f"/inboxes/{self.inbox}/messages", params=params)
        items, stamps = [], [ts for ts in (newest,) if ts]
        for message in body.get("messages") or []:
            stamp = str(message.get("timestamp") or "")
            if floor and stamp and stamp <= floor:
                continue  # already seen: not fetching beats de-duplicating
            if message.get("message_id"):
                items.append(self._item(message))
            stamps.append(stamp)
        newest = max((s for s in stamps if s), default=None)
        more = str(body.get("next_page_token") or "")
        return ChangePage(
            items=tuple(items),
            next_cursor=_PAGE + "|".join((more, floor or "", newest or "")) if more else None,
            resume_cursor=_RESUME + newest if newest else (cursor if isinstance(cursor, str) and cursor.startswith(_RESUME) else None),
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
        """``message_id`` is the RFC 5322 id — AgentMail's own key — so identity is stable across
        re-fetches and across any other transport that sees the same mail."""
        sender = str(message.get("from") or "")
        address = address_of(sender)
        thread = str(message.get("thread_id") or "")
        recipients = [str(r) for field in ("to", "cc") for r in message.get(field) or [] if r]
        data = EmailMessageData(
            subject=str(message.get("subject") or "") or None,
            text=str(message.get("preview") or "") or None,
            conversation=self.origin(thread) if thread else None,
            # The header as the provider reported it; the address is the identity.
            sender=UserProfile(origin=self.origin(address), name=sender or None, address=address) if address else None,
            sent_at=_when(message.get("timestamp")),
            recipients=tuple(UserProfile(origin=self.origin(addr), name=name or None, address=addr) for name, addr in getaddresses(recipients) if addr),
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
            return await self._reply_to(self.origin(latest), data, data.conversation)
        if len(data.recipients) != 1:
            raise Unsupported("an AgentMail send has exactly one recipient")
        to = data.recipients[0].address or data.recipients[0].origin.key
        body: dict[str, Any] = {"to": [to], "text": data.text}
        if getattr(data, "subject", None):
            body["subject"] = data.subject
        return self._sent(await self._api("POST", f"/inboxes/{self.inbox}/messages/send", json=body), data, None)

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        return await self._reply_to(origin, data, None)

    async def _reply_to(self, answered: CloudOrigin, data: MessageData, conversation: Optional[CloudOrigin]) -> MessageItem:
        # The RFC 5322 id rides in the PATH and holds `<`, `>` and `@`: raw, it is a 400 that reads
        # like a bad body.
        path = f"/inboxes/{self.inbox}/messages/{quote(self._key_of(answered), safe='')}/reply"
        sent = self._sent(await self._api("POST", path, json={"text": data.text}), data, conversation)
        return MessageItem(origin=sent.origin, data=sent.data.model_copy(update={"in_reply_to": answered}))

    def _sent(self, body: dict, data: MessageData, conversation: Optional[CloudOrigin]) -> MessageItem:
        message_id, thread = str(body.get("message_id") or ""), str(body.get("thread_id") or "")
        if not message_id:
            raise OutcomeUnknown("AgentMail accepted the message but returned no id for it")
        sent = EmailMessageData(
            text=data.text, subject=getattr(data, "subject", None), conversation=conversation or (self.origin(thread) if thread else None)
        )
        return MessageItem(origin=self.origin(message_id), data=sent)

    async def _latest_in(self, thread: str) -> str:
        listing = await self._api("GET", f"/inboxes/{self.inbox}/messages", params={"limit": 100})
        in_thread = [m for m in listing.get("messages") or [] if str(m.get("thread_id") or "") == thread and m.get("message_id")]
        if not in_thread:
            raise NotFound(f"no message in thread {thread} to continue")
        return str(max(in_thread, key=lambda m: str(m.get("timestamp") or ""))["message_id"])

    # ── transport ───────────────────────────────────────────────────────────
    def _key_of(self, origin: object) -> str:
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        if origin != self.origin(origin.key):
            raise ValueError(f"{origin!r} is outside this source's scope")
        return origin.key

    async def _api(self, verb: str, path: str, **kwargs: Any) -> dict:
        secret = self.credentials.values.get("api_key")
        if secret is None or not secret.get_secret_value():
            raise AccessDenied(
                f"No AgentMail key. Store it in the machine secret '{SECRET_NAME}' "
                "(the inbox is account-bound; the key is not a per-source form field)."
            )
        headers = {"Authorization": f"Bearer {secret.get_secret_value()}"}
        url = f"{self.base_url}{path}"
        if self._client is not None:
            response = await http.request(self._client, verb, url, headers=headers, ok_statuses=(401, 403), hint=f"{verb} {path}", **kwargs)
        else:
            async with http.client(REQUEST_TIMEOUT_SECONDS) as client:
                response = await http.request(client, verb, url, headers=headers, ok_statuses=(401, 403), hint=f"{verb} {path}", **kwargs)
        if response.status_code in (401, 403):
            raise AccessDenied(f"AgentMail refused the key: {verb} {path} answered {response.status_code}")
        try:
            return response.json() or {}
        except ValueError as exc:
            raise Rejected(f"AgentMail answered {verb} {path} with undecodable JSON") from exc


def address_of(sender: str) -> str:
    """``Joe <joe@x.to>`` → ``joe@x.to``."""
    return parseaddr(sender or "")[1] or (sender or "").strip()


def _check_outgoing(data: object) -> None:
    if not isinstance(data, MessageData):
        raise TypeError(f"expected MessageData, got {type(data).__name__}")
    if not (data.text or "").strip():
        raise ValueError("an AgentMail message needs text")
    if data.sender is not None or data.in_reply_to is not None or data.sent_at is not None or data.attachments:
        raise ValueError("sender, in_reply_to, sent_at and attachments are assigned by the provider")


def _start(query: Optional[MessageQuery], cursor: Optional[str]) -> tuple[Optional[str], Optional[str], str]:
    """``(floor, newest so far, page token)``."""
    if cursor is None:
        since = query.since if query is not None else None
        return (since.isoformat() if since else None), None, ""
    if not isinstance(cursor, str):
        raise TypeError(f"cursor must be a string, got {type(cursor).__name__}")
    if cursor.startswith(_RESUME) and len(cursor) > len(_RESUME):
        return cursor[len(_RESUME):], None, ""
    if cursor.startswith(_PAGE) and cursor.count("|") == 2:
        token, floor, newest = cursor[len(_PAGE):].split("|")
        if token:
            return floor or None, newest or None, token
    raise InvalidCursor("not an AgentMail cursor")


def _when(value: Any) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")) if value else None
    except ValueError:
        return None


__all__ = ["DEFAULT_BASE_URL", "PAGE_LIMIT", "SECRET_NAME", "AgentMailSource", "address_of"]
