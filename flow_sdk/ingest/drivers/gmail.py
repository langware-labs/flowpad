"""Gmail — an app-password mailbox over IMAP and SMTP.

The source stores only the mailbox address.  Its credential is read from the
process environment, so an app password never enters a DataSource row or its
``metadata.json`` shadow::

    GMAIL_ADDRESS=person@gmail.com
    GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx

    DataSource(provider="gmail", config={"address": "person@gmail.com"})

IMAP UIDs are the cursor because they are monotonic within one UIDVALIDITY.
RFC Message-ID remains the record identity shared with other mail transports;
the UID pair is only the stable fallback for malformed mail without one.
"""

from __future__ import annotations

import asyncio
import imaplib
import os
import re
import smtplib
from dataclasses import dataclass
from datetime import datetime, timezone
from email import policy
from email.message import EmailMessage, Message
from email.parser import BytesParser
from email.utils import formatdate, make_msgid, parseaddr, parsedate_to_datetime
from typing import Optional

from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest.driver import (
    FetchResult,
    IngestDriver,
    SegmentCursorView,
    SegmentRef,
    SendOutcome,
    SendStatus,
)
from flow_sdk.ingest.health import SourceError

GMAIL_ADDRESS_ENV = "GMAIL_ADDRESS"
GMAIL_APP_PASSWORD_ENV = "GMAIL_APP_PASSWORD"
IMAP_HOST = "imap.gmail.com"
SMTP_HOST = "smtp.gmail.com"
SMTP_SSL_PORT = 465
INBOX_SEGMENT = "INBOX"

# One bounded prefix per poll.  Advancing to the last fetched UID makes the
# next cycle resume at the following message without skipping the remainder.
PAGE_LIMIT = 50

_UID_RE = re.compile(rb"\bUID\s+(\d+)\b", re.IGNORECASE)
_THREAD_RE = re.compile(rb"\bX-GM-THRID\s+(\d+)\b", re.IGNORECASE)
_UID_VALIDITY_RE = re.compile(rb"(?:UIDVALIDITY\s+)?(\d+)", re.IGNORECASE)


@dataclass(frozen=True)
class _FetchedMessage:
    uid: int
    gmail_thread_id: str
    raw: bytes


@dataclass(frozen=True)
class _InboxSnapshot:
    uid_validity: str
    messages: tuple[_FetchedMessage, ...]


class _GmailAuthError(Exception):
    """An IMAP login refusal, separated from protocol/network failures."""


class GmailDriver(IngestDriver):
    provider = "gmail"
    kind = "datasource.api.gmail"
    record_kind = "content.message.email"
    sends = True
    identity_config_key = "address"

    def channel_for(self, source) -> str:
        return "gmail"

    async def segments(self, source) -> list[SegmentRef]:
        return [SegmentRef(INBOX_SEGMENT, _configured_address(source))]

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        address, app_password = _fetch_credentials(source)
        state = dict(cursor.state or {})
        saved_validity = str(state.get("uid_validity") or "")
        saved_uid = _as_uid(state.get("last_uid"))

        try:
            snapshot = await asyncio.to_thread(
                _fetch_inbox,
                address,
                app_password,
                saved_validity,
                saved_uid,
                cursor.window_start,
            )
        except _GmailAuthError as exc:
            raise SourceError.config("auth_failed", str(exc)) from exc
        except (imaplib.IMAP4.error, OSError, EOFError) as exc:
            raise SourceError.transient("imap_error", str(exc)) from exc

        return self._result_from(source, address, cursor, snapshot)

    def _result_from(
        self,
        source,
        address: str,
        cursor: SegmentCursorView,
        snapshot: _InboxSnapshot,
    ) -> FetchResult:
        """Map an IMAP snapshot and advance only within its UIDVALIDITY."""
        state = dict(cursor.state or {})
        saved_validity = str(state.get("uid_validity") or "")
        saved_uid = _as_uid(state.get("last_uid"))
        same_mailbox = saved_validity == snapshot.uid_validity
        floor = saved_uid if same_mailbox else 0
        messages = tuple(message for message in snapshot.messages if message.uid > floor)
        last_uid = max((message.uid for message in messages), default=floor)
        next_state = {**state, "uid_validity": snapshot.uid_validity, "last_uid": last_uid}

        items = [self._to_item(source, address, snapshot.uid_validity, message) for message in messages]
        return FetchResult(
            items=items,
            next_state=next_state,
            high_water=str(last_uid) if last_uid else None,
            unchanged=not messages,
        )

    def _to_item(
        self,
        source,
        address: str,
        uid_validity: str,
        fetched: _FetchedMessage,
    ) -> SourceItemSpec:
        message = BytesParser(policy=policy.default).parsebytes(fetched.raw)
        sender_name, sender_address = parseaddr(str(message.get("From") or ""))
        message_id = str(message.get("Message-ID") or "").strip()
        in_reply_to = str(message.get("In-Reply-To") or "").strip()
        thread_id = fetched.gmail_thread_id.strip()

        return SourceItemSpec(
            data_source_id=source.id,
            provider=self.provider,
            kind=self.record_kind,
            segment_key=INBOX_SEGMENT,
            segment_label=address,
            external_id=message_id or f"imap:{uid_validity}:{fetched.uid}",
            name=str(message.get("Subject") or ""),
            body=_message_body(message),
            occurred_at=_message_date(message),
            author_external_id=sender_address or None,
            author_display=sender_name or sender_address or None,
            thread_key=f"{address.casefold()}:{thread_id}" if thread_id else None,
            reply_to_external_id=in_reply_to or None,
            raw={
                "imap_uid": fetched.uid,
                "uid_validity": uid_validity,
                "gmail_thread_id": thread_id,
                "message_id": message_id,
                "in_reply_to": in_reply_to,
                "from": str(message.get("From") or ""),
                "to": str(message.get("To") or ""),
                "subject": str(message.get("Subject") or ""),
            },
        )

    async def send(
        self,
        source,
        *,
        thread_key: str,
        to: str,
        text: str,
        subject: str = "",
        conversation_id: str = "",
        in_reply_to: str = "",
    ) -> SendOutcome:
        """Send through Gmail without translating failures into SourceError.

        SourceError controls whether polling is parked.  An outbound SMTP
        failure must reach the caller as its native SMTP/OSError (and a missing
        credential as ValueError), never disable a healthy inbox.
        """
        address, app_password = _send_credentials(source)
        message = _smtp_message(
            sender=address,
            recipient=to,
            text=text,
            subject=subject,
            in_reply_to=in_reply_to,
        )
        await asyncio.to_thread(_send_smtp, address, app_password, message)
        return SendOutcome(
            external_id=str(message["Message-ID"] or ""),
            status=SendStatus.SENT,
            recorded=False,
        )

    async def find_reply(self, source, external_id: str) -> Optional[SourceItemSpec]:
        """Find one response by its RFC ``In-Reply-To`` header."""
        address, app_password = _fetch_credentials(source)
        try:
            snapshot = await asyncio.to_thread(
                _find_reply_inbox,
                address,
                app_password,
                external_id,
            )
        except _GmailAuthError as exc:
            raise SourceError.config("auth_failed", str(exc)) from exc
        except (imaplib.IMAP4.error, OSError, EOFError) as exc:
            raise SourceError.transient("imap_error", str(exc)) from exc
        if not snapshot.messages:
            return None
        return self._to_item(source, address, snapshot.uid_validity, snapshot.messages[-1])

    async def wait_for_reply(self, source, external_id: str) -> SourceItemSpec:
        """Wait until a correlated response appears.

        Each lookup scans only the newest tiny headers locally. Reconnecting
        between scans gives Gmail a fresh mailbox snapshot; unlike IMAP IDLE,
        this also works reliably for Workspace inboxes that do not signal an
        external delivery on the selected connection.
        """
        while True:
            reply = await self.find_reply(source, external_id)
            if reply is not None:
                return reply


def _configured_address(source) -> str:
    """The non-secret account identity; config wins so aliases are explicit."""
    return str((getattr(source, "config", None) or {}).get("address") or os.environ.get(GMAIL_ADDRESS_ENV) or "").strip()


def _credential_values(source) -> tuple[str, str]:
    """Read the shared Gmail identity and secret without classifying absence."""
    address = _configured_address(source)
    # Google displays app passwords in four groups separated by spaces. Those
    # spaces are presentation, not credential bytes.
    app_password = "".join(str(os.environ.get(GMAIL_APP_PASSWORD_ENV) or "").split())
    return address, app_password


def _fetch_credentials(source) -> tuple[str, str]:
    address, app_password = _credential_values(source)
    if not address:
        raise SourceError.config("no_address", f"config.address or {GMAIL_ADDRESS_ENV} is required")
    if not app_password:
        raise SourceError.config("no_app_password", f"{GMAIL_APP_PASSWORD_ENV} is required")
    return address, app_password


def _send_credentials(source) -> tuple[str, str]:
    """The same credential lookup with a non-health error for outbound calls."""
    address, app_password = _credential_values(source)
    if not address:
        raise ValueError(f"gmail send requires config.address or {GMAIL_ADDRESS_ENV}")
    if not app_password:
        raise ValueError(f"gmail send requires {GMAIL_APP_PASSWORD_ENV}")
    return address, app_password


def _fetch_inbox(
    address: str,
    app_password: str,
    saved_validity: str,
    saved_uid: int,
    window_start: Optional[str],
) -> _InboxSnapshot:
    client, uid_validity = _open_inbox(address, app_password)
    try:
        floor = saved_uid if saved_validity == uid_validity else 0

        if floor:
            status, data = client.uid("SEARCH", None, f"UID {floor + 1}:*")
        else:
            since = _imap_since(window_start)
            args = ("SINCE", since) if since else ("ALL",)
            status, data = client.uid("SEARCH", None, *args)
        _require_ok(status, "search INBOX")

        raw_uids = b" ".join(value for value in (data or []) if isinstance(value, bytes))
        uids = sorted({_as_uid(value) for value in raw_uids.split()} - {0})
        messages = _fetch_messages(client, uids[:PAGE_LIMIT])
        return _InboxSnapshot(uid_validity=uid_validity, messages=messages)
    finally:
        _close_inbox(client)


def _uid_validity(client: imaplib.IMAP4_SSL) -> str:
    _, values = client.response("UIDVALIDITY")
    raw = b" ".join(value for value in (values or []) if isinstance(value, bytes))
    match = _UID_VALIDITY_RE.search(raw)
    if match:
        return match.group(1).decode("ascii")

    status, values = client.status(INBOX_SEGMENT, "(UIDVALIDITY)")
    _require_ok(status, "read UIDVALIDITY")
    raw = b" ".join(value for value in (values or []) if isinstance(value, bytes))
    match = re.search(rb"UIDVALIDITY\s+(\d+)", raw, re.IGNORECASE)
    if not match:
        raise imaplib.IMAP4.error("INBOX did not report UIDVALIDITY")
    return match.group(1).decode("ascii")


def _find_reply_inbox(
    address: str,
    app_password: str,
    external_id: str,
) -> _InboxSnapshot:
    client, uid_validity = _open_inbox(address, app_password)
    try:
        return _InboxSnapshot(
            uid_validity=uid_validity,
            messages=_find_reply_messages(client, external_id),
        )
    finally:
        _close_inbox(client)


def _open_inbox(
    address: str,
    app_password: str,
) -> tuple[imaplib.IMAP4_SSL, str]:
    """Authenticate and select Gmail's inbox, cleaning up a partial open."""
    client = imaplib.IMAP4_SSL(IMAP_HOST)
    try:
        try:
            client.login(address, app_password)
        except imaplib.IMAP4.abort:
            raise
        except imaplib.IMAP4.error as exc:
            raise _GmailAuthError(str(exc)) from exc

        status, _ = client.select(INBOX_SEGMENT, readonly=True)
        _require_ok(status, "select INBOX")
        return client, _uid_validity(client)
    except Exception:
        try:
            client.logout()
        except (imaplib.IMAP4.error, OSError, EOFError):
            pass
        raise


def _find_reply_messages(
    client: imaplib.IMAP4_SSL,
    external_id: str,
) -> tuple[_FetchedMessage, ...]:
    # Gmail's server-side HEADER search scans the whole mailbox. On the live
    # validation account (~12k messages) one exact In-Reply-To query took 45s.
    # A response to a message just sent is necessarily at the tail: list UIDs,
    # fetch one bounded page of tiny headers, compare locally, then hydrate the
    # single match. This stays fast regardless of mailbox history or body size.
    status, data = client.uid("SEARCH", None, "ALL")
    _require_ok(status, "list reply candidates")
    raw_uids = b" ".join(value for value in (data or []) if isinstance(value, bytes))
    uids = sorted({_as_uid(value) for value in raw_uids.split()} - {0})[-PAGE_LIMIT:]
    headers = _fetch_message_parts(
        client,
        uids,
        "(UID X-GM-THRID BODY.PEEK[HEADER.FIELDS (IN-REPLY-TO)])",
    )
    wanted = str(external_id or "").strip().casefold()
    matches = [
        fetched.uid
        for fetched in headers
        if wanted in _header_message_ids(fetched.raw)
    ]
    return _fetch_messages(client, matches[-1:])


def _close_inbox(client: imaplib.IMAP4_SSL) -> None:
    # INBOX is always selected read-only, so CLOSE has nothing to commit or
    # expunge. Gmail occasionally stalls that redundant command; LOGOUT both
    # leaves the selected state and closes the connection in one round trip.
    try:
        client.logout()
    except (imaplib.IMAP4.error, OSError, EOFError):
        pass


def _fetch_messages(client: imaplib.IMAP4_SSL, requested_uids: list[int]) -> tuple[_FetchedMessage, ...]:
    """Fetch one UID page in one IMAP round trip."""
    return _fetch_message_parts(client, requested_uids, "(UID X-GM-THRID RFC822)")


def _fetch_message_parts(
    client: imaplib.IMAP4_SSL,
    requested_uids: list[int],
    query: str,
) -> tuple[_FetchedMessage, ...]:
    """Fetch one UID page and retain the returned MIME bytes."""
    if not requested_uids:
        return ()
    uid_set = ",".join(str(uid) for uid in requested_uids)
    status, parts = client.uid("FETCH", uid_set, query)
    _require_ok(status, f"fetch UIDs {uid_set}")
    messages: list[_FetchedMessage] = []
    for part in parts or []:
        if not isinstance(part, tuple) or len(part) < 2 or not isinstance(part[1], bytes):
            continue
        metadata = part[0] if isinstance(part[0], bytes) else str(part[0]).encode()
        uid_match = _UID_RE.search(metadata)
        thread_match = _THREAD_RE.search(metadata)
        if not uid_match:
            raise imaplib.IMAP4.error("fetch response carried no UID")
        uid = int(uid_match.group(1))
        thread_id = thread_match.group(1).decode("ascii") if thread_match else ""
        messages.append(_FetchedMessage(uid=uid, gmail_thread_id=thread_id, raw=part[1]))
    if len(messages) != len(requested_uids):
        raise imaplib.IMAP4.error(
            f"fetch requested {len(requested_uids)} message(s), returned {len(messages)}"
        )
    return tuple(sorted(messages, key=lambda message: message.uid))


def _header_message_ids(raw: bytes) -> set[str]:
    message = BytesParser(policy=policy.default).parsebytes(raw, headersonly=True)
    value = str(message.get("In-Reply-To") or "").strip().casefold()
    bracketed = re.findall(r"<[^>]+>", value)
    return set(bracketed or ([value] if value else []))


def _smtp_message(*, sender: str, recipient: str, text: str, subject: str, in_reply_to: str) -> EmailMessage:
    if not str(recipient or "").strip():
        raise ValueError("gmail send requires one recipient")
    message = EmailMessage(policy=policy.default)
    message["From"] = sender
    message["To"] = recipient
    message["Subject"] = subject
    message["Date"] = formatdate(localtime=False)
    domain = sender.rsplit("@", 1)[-1] if "@" in sender else None
    message["Message-ID"] = make_msgid(domain=domain)
    if in_reply_to:
        message["In-Reply-To"] = in_reply_to
        message["References"] = in_reply_to
    message.set_content(text)
    return message


def _send_smtp(address: str, app_password: str, message: EmailMessage) -> None:
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_SSL_PORT) as client:
        client.login(address, app_password)
        client.send_message(message)


def _message_body(message: Message) -> str:
    part = message.get_body(preferencelist=("plain", "html")) if message.is_multipart() else message
    if part is None:
        return ""
    content = part.get_content()
    if isinstance(content, bytes):
        return content.decode(part.get_content_charset() or "utf-8", errors="replace")
    return str(content)


def _message_date(message: Message) -> Optional[str]:
    raw = str(message.get("Date") or "").strip()
    if not raw:
        return None
    try:
        value = parsedate_to_datetime(raw)
    except (TypeError, ValueError, OverflowError):
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _imap_since(window_start: Optional[str]) -> str:
    if not window_start:
        return ""
    try:
        value = datetime.fromisoformat(str(window_start).replace("Z", "+00:00"))
    except ValueError:
        return ""
    return value.strftime("%d-%b-%Y")


def _as_uid(value) -> int:
    try:
        uid = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(uid, 0)


def _require_ok(status, operation: str) -> None:
    if str(status or "").upper() != "OK":
        raise imaplib.IMAP4.error(f"{operation} failed: {status}")
