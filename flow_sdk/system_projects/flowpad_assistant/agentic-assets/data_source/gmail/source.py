"""``GmailSource`` — an app-password mailbox over IMAP and SMTP, standard library only.

The row stores only the address; the app password reaches the source as a credential, never as
configuration. IMAP is blocking, so every mailbox call runs in a worker thread and a cancellation
settles before it propagates.

**The cursor is the UID pair.** IMAP UIDs are monotonic within one UIDVALIDITY, so the resume
cursor is ``(uid_validity, last_uid)``; a changed UIDVALIDITY starts the mailbox over. RFC
Message-ID stays the record's identity (shared with every other mail transport); the UID pair is
only the stable fallback for mail without one.

**Replies route from the answered message.** Its sender, subject and thread come from All Mail —
where our own sent mail also lives, so a reply to a message we sent routes too. A conversation
send continues the thread's latest message, because email continues a thread by replying.
"""
from __future__ import annotations

import imaplib
import re
import smtplib
from dataclasses import dataclass
from datetime import datetime, timezone
from email import policy
from email.message import EmailMessage, Message
from email.parser import BytesParser
from email.utils import formatdate, getaddresses, make_msgid, parseaddr, parsedate_to_datetime
from typing import Any, AsyncGenerator, ClassVar, Optional

from flow_sdk.sources.base import Source, positive_int
from flow_sdk.sources.email import EmailAddressing
from flow_sdk.sources.errors import AccessDenied, InvalidCursor, NotFound, Rejected, SourceUnavailable, Unsupported
from flow_sdk.sources.values.items import EmailMessageData, MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage
from flow_sdk.sources.values.query import DataQuery, MessageQuery
from flow_sdk.sources.values.segment import SegmentRef

IMAP_HOST = "imap.gmail.com"
SMTP_HOST = "smtp.gmail.com"
SMTP_SSL_PORT = 465
INBOX = "INBOX"
ALL_MAIL = "[Gmail]/All Mail"
#: One bounded prefix per page; the UID cursor resumes at the next message.
PAGE_LIMIT = 50

_RESUME = "uid:"
_FULL = "(UID X-GM-THRID RFC822)"
_ROUTING = "(UID X-GM-THRID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID FROM TO REPLY-TO SUBJECT)])"
_UID_RE = re.compile(rb"\bUID\s+(\d+)\b", re.IGNORECASE)
_THREAD_RE = re.compile(rb"\bX-GM-THRID\s+(\d+)\b", re.IGNORECASE)
_UID_VALIDITY_RE = re.compile(rb"(?:UIDVALIDITY\s+)?(\d+)", re.IGNORECASE)


class GmailMessageData(EmailMessageData):
    spec_kind: ClassVar[str] = "ingest.message.email.gmail"
    volatile: ClassVar[frozenset[str]] = frozenset({"raw"})

    raw: Optional[dict] = None


@dataclass(frozen=True)
class FetchedMessage:
    uid: int
    thread_id: str
    raw: bytes


@dataclass(frozen=True)
class Snapshot:
    uid_validity: str
    messages: tuple[FetchedMessage, ...]
    more: bool = False


class LoginRefused(Exception):
    """An IMAP login refusal, told apart from protocol and network failures."""


class GmailSource(EmailAddressing, Source):
    provider = "gmail"
    durable_cursor = True
    page_size = PAGE_LIMIT
    pages_per_pass = 1
    identity_config_key = "address"

    @classmethod
    def resume_at(cls, uid_validity: str, last_uid: int) -> str:
        return f"{_RESUME}{uid_validity}:{int(last_uid)}"

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def lift_cursor(cls, state: dict) -> Optional[str]:
        return cls.resume_at(state["uid_validity"], state.get("last_uid") or 0) if state.get("uid_validity") else None

    @classmethod
    def permalink(cls, external_id: str, thread_key: str = "") -> str:
        """Gmail's own UI, by thread (else the message). A formula, never a model-composed string:
        the link is digested, so a URL formatted differently on the next poll would rewrite the corpus."""
        if not (external_id or thread_key):
            return ""
        return f"https://mail.google.com/mail/u/0/#all/{thread_key or external_id}"

    @property
    def address(self) -> str:
        """The row's own address (so aliases are explicit), else the operator's ``GMAIL_ADDRESS``."""
        fallback = self.credentials.values.get("GMAIL_ADDRESS")
        address = str(self.config.get("address") or (fallback.get_secret_value() if fallback else "") or "").strip()
        if not address:
            raise Rejected("config.address or GMAIL_ADDRESS is required")
        return address

    def origin(self, key: str, *within: str) -> CloudOrigin:
        return super().origin(key, *(within or (INBOX,)))

    def thread_origin(self, thread_id: str) -> CloudOrigin:
        return self.origin(f"{self.address.casefold()}:{thread_id}")

    async def segments(self) -> list[SegmentRef]:
        return [SegmentRef(key=INBOX, label=self.address, query=MessageQuery())]

    # ── read ────────────────────────────────────────────────────────────────
    async def fetch(self, query: Optional[DataQuery] = None, *, cursor: Optional[str] = None, page_size: Optional[int] = None) -> ChangePage:
        self._require_open()
        if query is not None and not isinstance(query, DataQuery):
            raise TypeError(f"expected DataQuery, got {type(query).__name__}")
        if query is not None and (not isinstance(query, MessageQuery) or query.conversation is not None):
            raise Unsupported("Gmail lists the inbox; it does not read one thread")
        limit = self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        validity, floor = _decode(cursor)
        since = query.since if query is not None and cursor is None else None
        snapshot = await self._imap(list_inbox, self.address, self._password(), validity, floor, since, limit)
        floor = floor if validity == snapshot.uid_validity else 0
        last = max((message.uid for message in snapshot.messages), default=floor)
        token = self.resume_at(snapshot.uid_validity, last) if last else None
        return ChangePage(
            items=tuple(self._item(snapshot.uid_validity, message) for message in snapshot.messages),
            next_cursor=token if snapshot.more and token else None,
            resume_cursor=token,
        )

    async def iterate(self, query: Optional[DataQuery] = None, *, page_size: Optional[int] = None) -> AsyncGenerator[MessageItem, None]:
        cursor: Optional[str] = None
        while True:
            page = await self.fetch(query, cursor=cursor, page_size=page_size)
            for item in page.items:
                yield item
            if (cursor := page.next_cursor) is None:
                return

    async def find_reply(self, message_id: str) -> Optional[MessageItem]:
        """The newest inbox message whose ``In-Reply-To`` names ``message_id``, or ``None``."""
        snapshot = await self._imap(find_reply_inbox, self.address, self._password(), message_id)
        return self._item(snapshot.uid_validity, snapshot.messages[-1]) if snapshot.messages else None

    def _item(self, uid_validity: str, fetched: FetchedMessage) -> MessageItem:
        message = BytesParser(policy=policy.default).parsebytes(fetched.raw)
        name, sender = parseaddr(str(message.get("From") or ""))
        message_id = str(message.get("Message-ID") or "").strip()
        replied = str(message.get("In-Reply-To") or "").strip()
        thread = fetched.thread_id.strip()
        pairs = getaddresses([str(message.get("To") or ""), str(message.get("Cc") or "")])
        data = GmailMessageData(
            subject=str(message.get("Subject") or "") or None,
            text=message_body(message) or None,
            conversation=self.thread_origin(thread) if thread else None,
            sender=UserProfile(origin=self.origin(sender), name=name or sender or None, address=sender) if sender else None,
            sent_at=message_date(message),
            in_reply_to=self.origin(replied) if replied else None,
            recipients=tuple(UserProfile(origin=self.origin(addr), name=n or None, address=addr) for n, addr in pairs if addr),
            raw={
                "imap_uid": fetched.uid, "uid_validity": uid_validity, "gmail_thread_id": thread, "message_id": message_id,
                "in_reply_to": replied, "from": str(message.get("From") or ""), "to": str(message.get("To") or ""),
                "subject": str(message.get("Subject") or ""),
            },
        )
        return MessageItem(origin=self.origin(message_id or f"imap:{uid_validity}:{fetched.uid}"), data=data)

    # ── send ────────────────────────────────────────────────────────────────
    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if (data.conversation is None) == (not data.recipients):
            raise ValueError("address exactly one of a conversation or recipients")
        if data.conversation is not None:
            latest = await self._imap(latest_in_thread, self.address, self._password(), self._thread_of(data.conversation))
            if latest is None:
                raise NotFound("no message in that Gmail thread to continue")
            return await self._reply_to(latest, data, None, conversation=data.conversation)
        if len(data.recipients) != 1:
            raise Unsupported("a Gmail send has exactly one recipient")
        recipient = data.recipients[0].address or data.recipients[0].origin.key
        sent = await self._smtp(recipient, data, subject=getattr(data, "subject", None) or "", in_reply_to="")
        found = await self._imap(find_message, self.address, self._password(), sent.origin.key)
        thread = found.thread_id if found is not None else ""
        return MessageItem(origin=sent.origin, data=sent.data.model_copy(update={"conversation": self.thread_origin(thread) if thread else None}))

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        answered = await self._imap(find_message, self.address, self._password(), self._key_of(origin))
        if answered is None:
            raise NotFound(f"no message {origin.key} in this mailbox", origin=origin)
        return await self._reply_to(answered, data, origin)

    async def _reply_to(self, answered: FetchedMessage, data: MessageData, answered_origin: Optional[CloudOrigin], *, conversation: Optional[CloudOrigin] = None) -> MessageItem:
        headers = BytesParser(policy=policy.default).parsebytes(answered.raw, headersonly=True)
        message_id = str(headers.get("Message-ID") or "").strip()
        author = parseaddr(str(headers.get("Reply-To") or headers.get("From") or ""))[1]
        if author.casefold() == self.address.casefold():
            # Answering our own message continues with whoever it was addressed to.
            author = next((addr for _, addr in getaddresses([str(headers.get("To") or "")]) if addr), author)
        subject = getattr(data, "subject", None) or _reply_subject(str(headers.get("Subject") or ""))
        sent = await self._smtp(author, data, subject=subject, in_reply_to=message_id)
        thread = conversation or (self.thread_origin(answered.thread_id) if answered.thread_id else None)
        update = {"conversation": thread, "in_reply_to": answered_origin or self.origin(message_id)}
        return MessageItem(origin=sent.origin, data=sent.data.model_copy(update=update))

    async def _smtp(self, recipient: str, data: MessageData, *, subject: str, in_reply_to: str) -> MessageItem:
        message = smtp_message(sender=self.address, recipient=recipient, text=data.text or "", subject=subject, in_reply_to=in_reply_to)
        try:
            await self._blocking(send_smtp, self.address, self._password(), message)
        except smtplib.SMTPAuthenticationError as exc:
            raise AccessDenied(f"Gmail refused the SMTP login: {exc}") from exc
        except smtplib.SMTPRecipientsRefused as exc:
            raise Rejected(f"Gmail refused the recipient: {exc}") from exc
        except smtplib.SMTPException as exc:
            raise SourceUnavailable(f"SMTP: {exc}") from exc
        sent = EmailMessageData(text=data.text, subject=subject or None, sent_at=datetime.now(timezone.utc))
        return MessageItem(origin=self.origin(str(message["Message-ID"])), data=sent)

    # ── transport ───────────────────────────────────────────────────────────
    def _password(self) -> str:
        """``GMAIL_APP_PASSWORD``, with presentation whitespace dropped — Google shows an app password
        in four spaced groups."""
        secret = self.credentials.values.get("GMAIL_APP_PASSWORD")
        password = "".join(secret.get_secret_value().split()) if secret is not None else ""
        if not password:
            raise AccessDenied("GMAIL_APP_PASSWORD is required")
        return password

    async def _imap(self, fn: Any, *args: Any) -> Any:
        try:
            return await self._blocking(fn, *args)
        except LoginRefused as exc:
            raise AccessDenied(f"Gmail refused the login: {exc}") from exc
        except (imaplib.IMAP4.error, EOFError) as exc:
            raise SourceUnavailable(f"IMAP: {exc}") from exc

    def _key_of(self, origin: object) -> str:
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        if origin != self.origin(origin.key):
            raise ValueError(f"{origin!r} is outside this source's scope")
        return origin.key

    def _thread_of(self, conversation: object) -> str:
        prefix, _, thread = self._key_of(conversation).rpartition(":")
        if prefix != self.address.casefold() or not thread.isdigit():
            raise NotFound(f"{conversation!r} is not a Gmail thread in this mailbox")
        return thread


# ── blocking IMAP / SMTP, run in a worker thread ────────────────────────────


def list_inbox(address: str, password: str, saved_validity: str, floor: int, since: Optional[datetime], limit: int) -> Snapshot:
    client, uid_validity = open_inbox(address, password)
    try:
        floor = floor if saved_validity == uid_validity else 0
        if floor:
            status, data = client.uid("SEARCH", None, f"UID {floor + 1}:*")
        elif since is not None:
            status, data = client.uid("SEARCH", None, "SINCE", since.strftime("%d-%b-%Y"))
        else:
            status, data = client.uid("SEARCH", None, "ALL")
        _require_ok(status, "search INBOX")
        # `UID n:*` answers the highest UID even when nothing is newer: filter, never trust.
        uids = [uid for uid in _uids(data) if uid > floor]
        return Snapshot(uid_validity, _fetch_messages(client, uids[:limit]), more=len(uids) > limit)
    finally:
        close_inbox(client)


def find_reply_inbox(address: str, password: str, message_id: str) -> Snapshot:
    client, uid_validity = open_inbox(address, password)
    try:
        return Snapshot(uid_validity, _find_reply_messages(client, message_id))
    finally:
        close_inbox(client)


def find_message(address: str, password: str, message_id: str) -> Optional[FetchedMessage]:
    """The routing headers of one message in All Mail. The tail first — a message being answered is
    almost always recent, and Gmail's server-side HEADER search scans the whole mailbox (45s on a
    12k-message account) — then that search as the fallback."""
    client, _ = open_inbox(address, password, ALL_MAIL)
    try:
        status, data = client.uid("SEARCH", None, "ALL")
        _require_ok(status, "list All Mail")
        wanted = message_id.strip().casefold()
        tail = [m for m in _fetch_message_parts(client, _uids(data)[-PAGE_LIMIT:], _ROUTING) if _message_id_of(m.raw) == wanted]
        if tail:
            return tail[-1]
        status, data = client.uid("SEARCH", None, "HEADER", "Message-ID", message_id)
        _require_ok(status, "search Message-ID")
        found = _fetch_message_parts(client, _uids(data)[-1:], _ROUTING)
        return found[-1] if found else None
    finally:
        close_inbox(client)


def latest_in_thread(address: str, password: str, thread_id: str) -> Optional[FetchedMessage]:
    client, _ = open_inbox(address, password, ALL_MAIL)
    try:
        status, data = client.uid("SEARCH", None, "X-GM-THRID", thread_id)
        _require_ok(status, "search thread")
        found = _fetch_message_parts(client, _uids(data)[-1:], _ROUTING)
        return found[-1] if found else None
    finally:
        close_inbox(client)


def mailbox_arg(name: str) -> str:
    """A mailbox name as an IMAP quoted string (RFC 3501): `[Gmail]/All Mail` unquoted is "Could not
    parse command", and a quote or backslash inside a name must be escaped."""
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def open_inbox(address: str, password: str, mailbox: str = INBOX) -> tuple[imaplib.IMAP4_SSL, str]:
    """Authenticate and select ``mailbox`` read-only, cleaning up a partial open."""
    client = imaplib.IMAP4_SSL(IMAP_HOST)
    try:
        try:
            client.login(address, password)
        except imaplib.IMAP4.abort:
            raise
        except imaplib.IMAP4.error as exc:
            raise LoginRefused(str(exc)) from exc
        status, _ = client.select(mailbox_arg(mailbox), readonly=True)
        _require_ok(status, f"select {mailbox}")
        return client, _uid_validity(client, mailbox)
    except Exception:
        close_inbox(client)
        raise


def close_inbox(client: imaplib.IMAP4_SSL) -> None:
    # The mailbox is always selected read-only, so CLOSE has nothing to commit; Gmail sometimes
    # stalls on it, and LOGOUT leaves the selected state and the connection in one round trip.
    try:
        client.logout()
    except (imaplib.IMAP4.error, OSError, EOFError):
        pass


def _find_reply_messages(client: imaplib.IMAP4_SSL, message_id: str) -> tuple[FetchedMessage, ...]:
    """A response to a message just sent is at the tail: list UIDs, fetch one page of tiny
    ``In-Reply-To`` headers, compare locally, then hydrate the single newest match."""
    status, data = client.uid("SEARCH", None, "ALL")
    _require_ok(status, "list reply candidates")
    headers = _fetch_message_parts(client, _uids(data)[-PAGE_LIMIT:], "(UID X-GM-THRID BODY.PEEK[HEADER.FIELDS (IN-REPLY-TO)])")
    wanted = str(message_id or "").strip().casefold()
    matches = [fetched.uid for fetched in headers if wanted in _in_reply_to_ids(fetched.raw)]
    return _fetch_messages(client, matches[-1:])


def _fetch_messages(client: imaplib.IMAP4_SSL, uids: list[int]) -> tuple[FetchedMessage, ...]:
    """Fetch one UID page in one round trip."""
    return _fetch_message_parts(client, uids, _FULL)


def _fetch_message_parts(client: imaplib.IMAP4_SSL, uids: list[int], query: str) -> tuple[FetchedMessage, ...]:
    if not uids:
        return ()
    uid_set = ",".join(str(uid) for uid in uids)
    status, parts = client.uid("FETCH", uid_set, query)
    _require_ok(status, f"fetch UIDs {uid_set}")
    messages: list[FetchedMessage] = []
    for part in parts or []:
        if not isinstance(part, tuple) or len(part) < 2 or not isinstance(part[1], bytes):
            continue
        metadata = part[0] if isinstance(part[0], bytes) else str(part[0]).encode()
        uid_match, thread_match = _UID_RE.search(metadata), _THREAD_RE.search(metadata)
        if not uid_match:
            raise imaplib.IMAP4.error("fetch response carried no UID")
        messages.append(FetchedMessage(int(uid_match.group(1)), thread_match.group(1).decode("ascii") if thread_match else "", part[1]))
    if len(messages) != len(uids):
        raise imaplib.IMAP4.error(f"fetch requested {len(uids)} message(s), returned {len(messages)}")
    return tuple(sorted(messages, key=lambda message: message.uid))


def send_smtp(address: str, password: str, message: EmailMessage) -> None:
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_SSL_PORT) as client:
        client.login(address, password)
        client.send_message(message)


def smtp_message(*, sender: str, recipient: str, text: str, subject: str, in_reply_to: str) -> EmailMessage:
    """An outbound message carrying the cross-transport reply headers."""
    if not str(recipient or "").strip():
        raise ValueError("a Gmail send needs one recipient")
    message = EmailMessage(policy=policy.default)
    message["From"] = sender
    message["To"] = recipient
    message["Subject"] = subject
    message["Date"] = formatdate(localtime=False)
    message["Message-ID"] = make_msgid(domain=sender.rsplit("@", 1)[-1] if "@" in sender else None)
    if in_reply_to:
        message["In-Reply-To"] = in_reply_to
        message["References"] = in_reply_to
    message.set_content(text)
    return message


def message_body(message: Message) -> str:
    part = message.get_body(preferencelist=("plain", "html")) if message.is_multipart() else message
    if part is None:
        return ""
    content = part.get_content()
    return content.decode(part.get_content_charset() or "utf-8", errors="replace") if isinstance(content, bytes) else str(content)


def message_date(message: Message) -> Optional[datetime]:
    raw = str(message.get("Date") or "").strip()
    try:
        value = parsedate_to_datetime(raw) if raw else None
    except (TypeError, ValueError, OverflowError):
        return None
    return value if value is None or value.tzinfo else value.replace(tzinfo=timezone.utc)


def _uid_validity(client: imaplib.IMAP4_SSL, mailbox: str) -> str:
    _, values = client.response("UIDVALIDITY")
    match = _UID_VALIDITY_RE.search(b" ".join(v for v in (values or []) if isinstance(v, bytes)))
    if match:
        return match.group(1).decode("ascii")
    status, values = client.status(mailbox_arg(mailbox), "(UIDVALIDITY)")
    _require_ok(status, "read UIDVALIDITY")
    match = re.search(rb"UIDVALIDITY\s+(\d+)", b" ".join(v for v in (values or []) if isinstance(v, bytes)), re.IGNORECASE)
    if not match:
        raise imaplib.IMAP4.error(f"{mailbox} did not report UIDVALIDITY")
    return match.group(1).decode("ascii")


def _uids(data: Any) -> list[int]:
    raw = b" ".join(value for value in (data or []) if isinstance(value, bytes))
    return sorted({int(value) for value in raw.split() if value.isdigit()} - {0})


def _in_reply_to_ids(raw: bytes) -> set[str]:
    value = str(BytesParser(policy=policy.default).parsebytes(raw, headersonly=True).get("In-Reply-To") or "").strip().casefold()
    return set(re.findall(r"<[^>]+>", value) or ([value] if value else []))


def _message_id_of(raw: bytes) -> str:
    return str(BytesParser(policy=policy.default).parsebytes(raw, headersonly=True).get("Message-ID") or "").strip().casefold()


def _reply_subject(subject: str) -> str:
    return subject if not subject or subject.lower().startswith("re:") else f"Re: {subject}"


def _require_ok(status: Any, operation: str) -> None:
    if str(status or "").upper() != "OK":
        raise imaplib.IMAP4.error(f"{operation} failed: {status}")


def _decode(cursor: object) -> tuple[str, int]:
    if cursor is None:
        return "", 0
    if not isinstance(cursor, str):
        raise TypeError(f"cursor must be a string, got {type(cursor).__name__}")
    validity, _, last = cursor[len(_RESUME):].rpartition(":") if cursor.startswith(_RESUME) else ("", "", "")
    if not validity or not last.isdigit():
        raise InvalidCursor("not a Gmail cursor")
    return validity, int(last)


def _check_outgoing(data: object) -> None:
    if not isinstance(data, MessageData):
        raise TypeError(f"expected MessageData, got {type(data).__name__}")
    if not (data.text or "").strip():
        raise ValueError("a Gmail message needs text")
    if data.sender is not None or data.in_reply_to is not None or data.sent_at is not None or data.attachments:
        raise ValueError("sender, in_reply_to, sent_at and attachments are assigned by the provider")


__all__ = ["ALL_MAIL", "INBOX", "PAGE_LIMIT", "GmailMessageData", "GmailSource", "message_body", "message_date", "smtp_message"]
