"""``WahaSource`` — a WhatsApp number linked to WAHA, the self-hosted WhatsApp HTTP API.

WAHA logs into WhatsApp as a LINKED DEVICE of a real phone (the number's WhatsApp Business app),
so there is no Meta app, no 24-hour window and no public URL: the container posts every message to
this instance and sends through ``/api/sendText``. The price is an unofficial client — use a number
you can afford to lose.

Four facts shape the class:

* **The session is the account.** Verify creates the WAHA session (or updates it) with this
  instance's webhook and the signing key, and a delivery names its session — the row's
  ``identity_config_key``. Until the phone scans the QR the session reads ``SCAN_QR_CODE``.
* **The chat id is the address.** WhatsApp identifies a person as ``<digits>@c.us`` or, more and
  more, as an opaque ``<id>@lid``. A reply goes to the raw chat id; rebuilding one from digits
  addresses nobody. Only the SENDER key is folded to digits where it can be, so an allowlist of
  phone numbers still matches.
* **No echo of itself.** The session subscribes to ``message`` only — never ``message.any`` — and
  ``fromMe`` is dropped besides, so the agent cannot answer its own replies.
* **Signed deliveries.** WAHA signs each body with the key as ``X-Webhook-Hmac`` (hex HMAC-SHA512).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any, ClassVar, Mapping, Optional

from pydantic import StringConstraints

from flow_sdk.sources import http
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.credentials import Credentials
from flow_sdk.sources.errors import (
    AccessDenied,
    NotFound,
    OutcomeUnknown,
    Rejected,
    SourceError,
    SourceUnavailable,
    Unsupported,
)
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.values.event import DataSourceEvent, EventKind
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin

#: One number, one webhook: every conversation is a chat under it.
MESSAGES_STREAM = "messages"
#: The only event the session subscribes to. ``message.any`` would echo our own sends.
WEBHOOK_EVENTS = ("message",)
#: Chat-id suffixes that name a phone number, so the sender key can be its digits.
PHONE_SUFFIXES = ("@c.us", "@s.whatsapp.net")
#: Statuses WAHA answers with a JSON message worth quoting, so the call reads the body before raising.
_REFUSED = (400, 401, 403, 404, 422)


class WahaMessageData(MessageData):
    spec_kind: ClassVar[str] = "ingest.message.waha"
    volatile: ClassVar[frozenset[str]] = frozenset({"raw"})

    raw: Optional[dict] = None


class WahaConfig(SourceConfig):
    """What a waha source is configured with."""

    base_url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    session: str = "default"
    webhook_url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    #: Who may drive the number; the row keeps it as ``inbound_allowed_senders``.
    allowed_senders: list[Annotated[str, StringConstraints(pattern=r"^([0-9]+|[^@\s]+@lid)$")]] = []


class WahaSource(MessageSource):

    Config = WahaConfig
    provider = "waha"
    #: The same channel as the Cloud API source: one WhatsApp, whichever transport carries it.
    origin_kind = "whatsapp"
    identity_config_key = "session"

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._client: Any = None

    @property
    def base_url(self) -> str:
        return str(self.config.get("base_url") or "").strip().rstrip("/")

    @property
    def session(self) -> str:
        return str(self.config.get("session") or "default").strip()

    def origin(self, key: str, *within: str) -> CloudOrigin:
        return super().origin(key, *(within or (MESSAGES_STREAM,)))

    def conversation_origin(self, chat: str) -> CloudOrigin:
        """The chat, which is the conversation."""
        return self.origin(chat)

    def message_origin(self, message_id: str, chat: str) -> CloudOrigin:
        return self.origin(message_id, MESSAGES_STREAM, chat)

    @property
    def _scope_namespace(self) -> str:
        """The namespace every origin this source mints sits in — a chat hangs off it."""
        return self.origin("-").namespace

    def _chat_from(self, origin: CloudOrigin) -> str:
        """The chat an in-scope origin hangs off; "" when it names the namespace itself."""
        base = self._scope_namespace
        if origin.kind != self._scope.kind or not (origin.namespace == base or origin.namespace.startswith(base + "/")):
            raise ValueError(f"{origin!r} is outside this source's scope")
        return chat_id(origin.namespace[len(base) + 1:]) if origin.namespace != base else ""

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def outbound_spec(cls) -> type:
        from flow_sdk.builtin.source_item import WhatsAppMessageSpec  # noqa: PLC0415

        return WhatsAppMessageSpec

    def message_for(self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""):
        """``to`` is the chat — the conversation — and ``in_reply_to`` quotes one message in it."""
        chat = chat_id(thread_key) or chat_id(to)
        if not chat:
            raise ValueError("a WAHA send needs the chat id (or the phone number) in `to`")
        quoted = str(in_reply_to or "").strip()
        if quoted:
            return MessageData(text=text), self.message_origin(quoted, chat)
        return MessageData(text=text, conversation=self.conversation_origin(chat)), None

    @classmethod
    def webhook_account(cls, payload: dict) -> str:
        return str(payload.get("session") or "") if isinstance(payload, dict) else ""

    @classmethod
    def webhook_authentic(cls, headers: Mapping[str, str], body: bytes, credentials: Credentials) -> bool:
        """``X-Webhook-Hmac``: hex HMAC-SHA512 of the raw body under the session's key. No key accepts nothing."""
        import hashlib  # noqa: PLC0415
        import hmac  # noqa: PLC0415

        stored = credentials.values.get("webhook_hmac")
        key = stored.get_secret_value() if stored is not None else ""
        offered = str(headers.get("x-webhook-hmac") or "")
        if not key or not offered:
            return False
        return hmac.compare_digest(hmac.new(key.encode(), body, hashlib.sha512).hexdigest(), offered)

    async def _open(self) -> None:
        self._client = http.client()

    async def _close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ── inbound: the webhook ────────────────────────────────────────────────
    def events_from_webhook(self, payload: Any) -> list[DataSourceEvent]:
        """A WAHA delivery → the message it carries. Total: any other event, our own message, a group
        chat or a message with no words yields nothing, because a failed webhook is retried."""
        if not isinstance(payload, dict) or payload.get("event") not in WEBHOOK_EVENTS:
            return []
        item = self._item(payload.get("payload"))
        return [DataSourceEvent(id=item.origin.key, kind=EventKind.UPSERT, origin=item.origin, item=item)] if item else []

    def _item(self, message: Any) -> Optional[MessageItem]:
        if not isinstance(message, dict) or message.get("fromMe"):
            return None
        message_id, chat = str(message.get("id") or "").strip(), str(message.get("from") or "").strip()
        text = str(message.get("body") or "").strip()
        if not (message_id and chat and text) or chat.endswith("@g.us"):
            return None
        reply_to = message.get("replyTo")
        quoted = str(reply_to.get("id") or "") if isinstance(reply_to, dict) else ""
        extra = message.get("_data") if isinstance(message.get("_data"), dict) else {}
        data = WahaMessageData(
            text=text,
            conversation=self.conversation_origin(chat),
            sender=UserProfile(origin=self.origin(sender_key(phone_chat(extra, chat))), name=str(extra.get("notifyName") or extra.get("pushName") or "") or None),
            sent_at=_when(message.get("timestamp")),
            in_reply_to=self.message_origin(quoted, chat) if quoted else None,
            raw=message,
        )
        return MessageItem(origin=self.message_origin(message_id, chat), data=data)

    # ── setup ───────────────────────────────────────────────────────────────
    async def verify(self) -> Verdict:
        """The session exists with this instance's webhook, and the phone is paired. Creating or
        re-pointing the session is part of verifying it: a person never configures WAHA by hand."""
        if not self.base_url:
            return Verdict(ready=False, detail="No WAHA URL yet — where does the container answer?")
        if self._secret("api_key") is None:
            return Verdict(ready=False, detail="No WAHA API key — declare the `waha` credential (WAHA_API_KEY) in the agent's project.")
        try:
            session = await self._ensure_session()
        except AccessDenied:
            return Verdict(ready=False, detail="WAHA refused the API key — it must match the container's WAHA_API_KEY.")
        except SourceUnavailable:
            return Verdict(ready=False, detail=f"WAHA does not answer at {self.base_url} — is the container running?")
        except SourceError as exc:
            return Verdict(ready=False, detail=f"WAHA refused the request: {exc}")
        status = str(session.get("status") or "")
        if status == "WORKING":
            number = sender_key(str((session.get("me") or {}).get("id") or ""))
            return Verdict(ready=True, detail=f"Sending as +{number} through WAHA session {self.session}.")
        if status == "SCAN_QR_CODE":
            return Verdict(
                ready=False,
                detail=f"Pair the phone: in WhatsApp Business open Linked devices and scan the QR at "
                f"{self.base_url}/api/{self.session}/auth/qr, then verify again.",
            )
        return Verdict(ready=False, detail=f"The WAHA session is {status or 'not running'} — verify again in a moment.")

    async def whoami(self) -> tuple[UserProfile, ...]:
        me = (await self._api("GET", f"/api/sessions/{self.session}")).get("me") or {}
        number = sender_key(str(me.get("id") or ""))
        return (UserProfile(origin=CloudOrigin(kind="whatsapp", namespace="account", key=number)),) if number else ()

    async def _ensure_session(self) -> dict:
        """The session, created with this instance's webhook or re-pointed at it."""
        webhook = self._webhook()
        try:
            session = await self._api("GET", f"/api/sessions/{self.session}")
        except NotFound:
            return await self._api("POST", "/api/sessions", json={"name": self.session, "start": True, "config": {"webhooks": [webhook]}})
        hooks = ((session.get("config") or {}).get("webhooks") or []) if isinstance(session.get("config"), dict) else []
        if not any(isinstance(h, dict) and h.get("url") == webhook["url"] for h in hooks):
            session = await self._api("PUT", f"/api/sessions/{self.session}", json={"config": {**(session.get("config") or {}), "webhooks": [webhook]}})
        if str(session.get("status") or "") in ("STOPPED", "FAILED"):
            session = await self._api("POST", f"/api/sessions/{self.session}/start")
        return session

    def _webhook(self) -> dict:
        url = str(self.config.get("webhook_url") or "").strip()
        if not url:
            raise Rejected("this source has no webhook_url — how WAHA reaches this instance")
        hook: dict[str, Any] = {"url": url, "events": list(WEBHOOK_EVENTS)}
        key = self._secret("webhook_hmac")
        if key:
            hook["hmac"] = {"key": key}
        return hook

    # ── send ────────────────────────────────────────────────────────────────
    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if (data.conversation is None) == (not data.recipients):
            raise ValueError("address exactly one of a conversation or recipients")
        if data.conversation is not None:
            chat, conversation = self._chat_of(data.conversation), data.conversation
        else:
            if len(data.recipients) != 1:
                raise Unsupported("a WhatsApp message goes to exactly one chat")
            chat = chat_id(data.recipients[0].origin.key)
            conversation = self.conversation_origin(chat)
        if not chat:
            raise NotFound("no WhatsApp chat to send to")
        return await self._send(chat, data.text or "", conversation, quoted="")

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        chat = self._chat_from(origin)
        if not chat:
            raise NotFound(f"{origin!r} names no message", origin=origin)
        sent = await self._send(chat, data.text or "", self.conversation_origin(chat), quoted=origin.key)
        return MessageItem(origin=sent.origin, data=sent.data.model_copy(update={"in_reply_to": origin}))

    async def _send(self, chat: str, text: str, conversation: CloudOrigin, *, quoted: str) -> MessageItem:
        payload: dict[str, Any] = {"session": self.session, "chatId": chat, "text": text}
        if quoted:
            payload["reply_to"] = quoted
        body = await self._api("POST", "/api/sendText", json=payload)
        sent_id = _id_of(body)
        if not sent_id:
            raise OutcomeUnknown("WAHA accepted the message but returned no id for it")
        me = str(self.binding.account_key or self.session)
        data = WahaMessageData(
            text=text,
            conversation=conversation,
            sender=UserProfile(origin=CloudOrigin(kind="whatsapp", namespace="account", key=me)),
            sent_at=datetime.now(timezone.utc),
            raw=body,
        )
        return MessageItem(origin=self.message_origin(sent_id, chat), data=data)

    # ── transport ───────────────────────────────────────────────────────────
    def _chat_of(self, origin: object) -> str:
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        if origin.kind != self._scope.kind or origin.namespace != self._scope_namespace:
            raise ValueError(f"{origin!r} is outside this source's scope")  # a message hangs off a chat; a chat IS one
        return chat_id(origin.key)

    def _secret(self, name: str) -> Optional[str]:
        stored = self.credentials.values.get(name)
        return stored.get_secret_value() if stored is not None and stored.get_secret_value() else None

    async def _api(self, verb: str, path: str, **kwargs: Any) -> dict:
        """One WAHA call through the shared transport, which owns the status→error table (so a
        rate-limited or restarting container reads as unavailable, not as a refusal). WAHA's own
        message rides the error as the hint."""
        key = self._secret("api_key")
        if key is None:
            raise AccessDenied("This WAHA source has no API key.")
        url, headers = f"{self.base_url}{path}", {"X-Api-Key": key}
        if self._client is not None:
            return await self._call(self._client, verb, url, headers, kwargs)
        async with http.client() as client:
            return await self._call(client, verb, url, headers, kwargs)

    @staticmethod
    async def _call(client: Any, verb: str, url: str, headers: dict, kwargs: dict) -> dict:
        response = await http.request(client, verb, url, headers=headers, ok_statuses=_REFUSED, **kwargs)
        try:
            body = response.json() if response.content else {}
        except ValueError as exc:
            raise SourceUnavailable(f"WAHA answered {verb} {url} with undecodable JSON") from exc
        if response.status_code >= 400:
            raise http.error_for_status(response.status_code, f"WAHA: {(body.get('message') if isinstance(body, dict) else '') or ''}".strip())
        return body if isinstance(body, dict) else {}


def digits(value: Any) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def chat_id(value: Any) -> str:
    """A chat id as WAHA addresses it: kept as-is when it carries its server, else a phone number's."""
    text = str(value or "").strip()
    if "@" in text:
        return text
    number = digits(text)
    return f"{number}@c.us" if number else ""


def sender_key(chat: str) -> str:
    """Who wrote: a phone number's digits where the chat names one, else the opaque id itself."""
    return digits(chat.split("@", 1)[0]) if chat.endswith(PHONE_SUFFIXES) else chat


def phone_chat(extra: dict, chat: str) -> str:
    """The chat id that names the sender's PHONE. WhatsApp increasingly addresses a person by an opaque
    ``<id>@lid``; NOWEB carries the phone JID beside it in the message key (``_data.key``), so an
    allowlist of numbers still matches. Without one the lid stands — it can be allowlisted as it is.
    Replies keep the raw chat."""
    if not chat.endswith("@lid"):
        return chat
    key = extra.get("key") if isinstance(extra.get("key"), dict) else {}
    alts = (key.get("remoteJidAlt"), key.get("senderPn"), key.get("participantPn"))
    return next((alt for alt in alts if isinstance(alt, str) and alt.endswith(PHONE_SUFFIXES)), chat)


def _id_of(body: dict) -> str:
    """WAHA's engines answer ``id`` as a string or as ``{"_serialized": ...}``; NOWEB answers only the
    message ``key`` (``{remoteJid, fromMe, id}``), which serializes the way WAHA writes message ids."""
    value = body.get("id")
    if isinstance(value, dict):
        value = value.get("_serialized") or value.get("id")
    if not value and isinstance(body.get("key"), dict):
        key = body["key"]
        if key.get("id") and key.get("remoteJid"):
            value = f"{str(bool(key.get('fromMe'))).lower()}_{key['remoteJid']}_{key['id']}"
    return str(value or "").strip()


def _check_outgoing(data: object) -> None:
    if not isinstance(data, MessageData):
        raise TypeError(f"expected MessageData, got {type(data).__name__}")
    if not (data.text or "").strip():
        raise ValueError("a WhatsApp message needs text")
    if data.sender is not None or data.in_reply_to is not None or data.sent_at is not None or data.attachments:
        raise ValueError("sender, in_reply_to, sent_at and attachments are assigned by the provider")


def _when(timestamp: Any) -> datetime:
    """Unix seconds — or milliseconds, which one engine sends."""
    try:
        value = int(float(str(timestamp)))
    except (TypeError, ValueError):
        return datetime.now(timezone.utc)
    return datetime.fromtimestamp(value / 1000 if value > 10**12 else value, tz=timezone.utc)


__all__ = ["MESSAGES_STREAM", "WEBHOOK_EVENTS", "WahaMessageData", "WahaSource", "chat_id", "digits", "sender_key"]
