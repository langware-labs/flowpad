"""``WhatsAppSource`` — a business number on Meta's Cloud API.

**Nothing to list.** The Cloud API has no endpoint that lists messages: inbound arrives once, as
a webhook POST from Meta, and if it is dropped it is gone. So this source is not ``Listable``;
``events_from_webhook`` turns Meta's envelope into the contract's events, and the application's
webhook route hands them to its one ingestion chokepoint.

Three more facts:

* **No echo of itself.** Our own outbound comes back only as a delivery ``status``, never as a
  message (``echoes_sends = False``): what ``send`` returns is the only copy there will be.
* **No threads.** The conversation IS the pair (business number, person), so a conversation's
  key is the person's ``wa_id`` and a message lives in that person's scope —
  ``(whatsapp, <account>/messages/<wa_id>, <wamid>)`` — which is what lets a reply be routed
  from the answered message alone. A quote (``context.id``) is provenance, never membership.
* **The 24-hour window.** A free-form message is allowed only within 24h of the person's last
  one; outside it Meta accepts nothing but an approved template. An answer is inside the window
  by construction, so this sends plain text and lets Meta's own refusal surface when it is not.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, ClassVar, Optional

from flow_sdk.sources import http
from flow_sdk.sources.base import Source
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import (
    AccessDenied,
    NotFound,
    OutcomeUnknown,
    Rejected,
    SourceError,
    SourceUnavailable,
    Unsupported,
)
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.values.event import DataSourceEvent, EventKind
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.segment import SegmentRef

#: Graph's base. Overridable only so a test can point at a local double.
GRAPH_API_BASE = "https://graph.facebook.com"
#: Pinned: Meta versions the whole surface and deprecates on a schedule, so the version is a fact
#: about this source, not a default to inherit from whatever Meta serves today.
GRAPH_VERSION = "v23.0"
#: A source is ABOUT one business number, and every conversation arrives through one webhook.
MESSAGES_SEGMENT = "messages"
#: Message types that are sentences someone wrote; a reaction or a system notice is not.
TEXTUAL = frozenset({"text", "button", "interactive"})


class WhatsAppMessageData(MessageData):
    spec_kind: ClassVar[str] = "ingest.message.whatsapp"
    volatile: ClassVar[frozenset[str]] = frozenset({"raw"})

    raw: Optional[dict] = None


class WhatsAppSource(Source):
    provider = "whatsapp"
    echoes_sends = False
    identity_config_key = "phone_number_id"

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._client: Any = None

    @property
    def phone_number_id(self) -> str:
        return str(self.config.get("phone_number_id") or "").strip()

    def origin(self, key: str, *within: str) -> CloudOrigin:
        return super().origin(key, *(within or (MESSAGES_SEGMENT,)))

    def conversation_origin(self, wa_id: str) -> CloudOrigin:
        """The person, who is the conversation."""
        return self.origin(wa_id)

    def message_origin(self, message_id: str, wa_id: str) -> CloudOrigin:
        return self.origin(message_id, MESSAGES_SEGMENT, wa_id)

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def outbound_spec(cls) -> type:
        from flow_sdk.builtin.source_item import WhatsAppMessageSpec  # noqa: PLC0415

        return WhatsAppMessageSpec

    def message_for(self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""):
        """``to`` is the person's wa_id — the person IS the conversation — and ``in_reply_to`` quotes
        their message, which renders as a quote and starts no thread. A subject has no equivalent."""
        wa_id = digits(to) or digits(thread_key)
        if not wa_id:
            raise ValueError("a whatsapp send needs the recipient's wa_id in `to`")
        quoted = str(in_reply_to or "").strip()
        if quoted:
            return MessageData(text=text), self.message_origin(quoted, wa_id)
        return MessageData(text=text, conversation=self.conversation_origin(wa_id)), None

    @classmethod
    def webhook_challenge(cls, params: dict, configs: list) -> Optional[str]:
        """Meta's one-time handshake: the challenge back when ``hub.verify_token`` matches a row's,
        compared in constant time against every row so a wrong guess is not distinguishable by how
        long the refusal took. ``None`` refuses."""
        import hmac  # noqa: PLC0415

        if params.get("hub.mode") != "subscribe":
            return None
        offered = str(params.get("hub.verify_token") or "")
        matched = False
        for config in configs:
            expected = str((config or {}).get("verify_token") or "")
            if expected and hmac.compare_digest(expected, offered):
                matched = True
        return str(params.get("hub.challenge") or "") if matched else None

    @classmethod
    def webhook_account(cls, payload: dict) -> str:
        """Which business number a delivery is about — the row's ``phone_number_id``. Meta nests it three
        deep and repeats it per change; the first wins, because one POST is about one number."""
        for entry in _list(payload.get("entry") if isinstance(payload, dict) else None):
            for change in _list(entry.get("changes") if isinstance(entry, dict) else None):
                value = change.get("value") if isinstance(change, dict) else None
                metadata = value.get("metadata") if isinstance(value, dict) else None
                if isinstance(metadata, dict) and metadata.get("phone_number_id"):
                    return str(metadata["phone_number_id"])
        return ""

    async def _open(self) -> None:
        self._client = http.client()

    async def _close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def segments(self) -> list[SegmentRef]:
        return [SegmentRef(key=MESSAGES_SEGMENT, label=self.phone_number_id)]

    # ── inbound: the webhook ────────────────────────────────────────────────
    def events_from_webhook(self, payload: Any) -> list[DataSourceEvent]:
        """Meta's webhook body → the messages it carries, as upserts. Pure, and total: Meta posts
        the same envelope for receipts, alerts and types nothing renders, and a webhook that
        fails is RETRIED — so an unknown shape yields nothing rather than an error."""
        events: list[DataSourceEvent] = []
        for entry in _list(payload.get("entry") if isinstance(payload, dict) else None):
            for change in _list(entry.get("changes") if isinstance(entry, dict) else None):
                value = change.get("value") if isinstance(change, dict) and isinstance(change.get("value"), dict) else {}
                # `statuses` is the delivery-receipt lane for messages WE sent: nobody wrote those.
                names = {
                    digits(c.get("wa_id")): str((c.get("profile") or {}).get("name") or "")
                    for c in _list(value.get("contacts"))
                    if isinstance(c, dict)
                }
                for message in _list(value.get("messages")):
                    item = self._item(message, names) if isinstance(message, dict) else None
                    if item is not None:
                        events.append(DataSourceEvent(id=item.origin.key, kind=EventKind.UPSERT, origin=item.origin, item=item))
        return events

    def _item(self, message: dict, names: dict[str, str]) -> Optional[MessageItem]:
        message_id, wa_id, kind = str(message.get("id") or "").strip(), digits(message.get("from")), str(message.get("type") or "")
        text = _text_of(message, kind) if kind in TEXTUAL else ""
        if not (message_id and wa_id and text):
            return None
        quoted = str((message.get("context") or {}).get("id") or "")
        data = WhatsAppMessageData(
            text=text,
            conversation=self.conversation_origin(wa_id),
            sender=UserProfile(origin=self.conversation_origin(wa_id), name=names.get(wa_id) or None),
            sent_at=_when(message.get("timestamp")),
            in_reply_to=self.message_origin(quoted, wa_id) if quoted else None,
            raw=message,
        )
        return MessageItem(origin=self.message_origin(message_id, wa_id), data=data)

    # ── setup ───────────────────────────────────────────────────────────────
    async def verify(self) -> Verdict:
        """One ``GET /{phone_number_id}``: a wrong id is refused, a bad or expired token is refused,
        and a token for a DIFFERENT business fails on the id rather than sending from elsewhere."""
        if not self.phone_number_id:
            return Verdict(ready=False, detail="No business number yet — paste the phone number ID from the Meta app.")
        if self._token() is None:
            return Verdict(ready=False, detail="No access token yet — paste one from the Meta app's WhatsApp setup.")
        try:
            number = await self._display_number()
        except AccessDenied:
            return Verdict(
                ready=False,
                detail="Meta refused the token. A temporary token from the setup page expires in 24 hours — "
                "create a System User token for one that does not.",
            )
        except SourceError as exc:
            return Verdict(ready=False, detail=f"Meta refused the request: {exc}")
        return Verdict(ready=True, detail=f"Sending as {number or self.phone_number_id}. Point Meta's webhook at this instance.")

    async def whoami(self) -> tuple[UserProfile, ...]:
        number = await self._display_number()
        profiles = [UserProfile(origin=CloudOrigin(kind="whatsapp", namespace="business", key=self.phone_number_id), name=number or None)]
        if digits(number) and digits(number) != self.phone_number_id:
            profiles.append(UserProfile(origin=CloudOrigin(kind="whatsapp", namespace="business", key=digits(number))))
        return tuple(profiles)

    async def _display_number(self) -> str:
        body = await self._graph("GET", self.phone_number_id, params={"fields": "display_phone_number"})
        return str(body.get("display_phone_number") or "").strip()

    # ── send ────────────────────────────────────────────────────────────────
    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if (data.conversation is None) == (not data.recipients):
            raise ValueError("address exactly one of a conversation or recipients")
        if data.conversation is not None:
            wa_id, conversation = self._person_of(data.conversation), data.conversation
        else:
            if len(data.recipients) != 1:
                raise Unsupported("a WhatsApp message goes to exactly one person")
            wa_id = digits(data.recipients[0].origin.key)
            conversation = self.conversation_origin(wa_id)
        if not wa_id:
            raise NotFound("no WhatsApp number to send to")
        return await self._send(wa_id, data.text or "", conversation, quoted="")

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        base = self.origin("-").namespace
        if origin.kind != self._scope.kind or not (origin.namespace == base or origin.namespace.startswith(base + "/")):
            raise ValueError(f"{origin!r} is outside this source's scope")
        wa_id = digits(origin.namespace[len(base) + 1:]) if origin.namespace != base else ""
        if not wa_id:
            raise NotFound(f"{origin!r} names no message", origin=origin)
        sent = await self._send(wa_id, data.text or "", self.conversation_origin(wa_id), quoted=origin.key)
        return MessageItem(origin=sent.origin, data=sent.data.model_copy(update={"in_reply_to": origin}))

    async def _send(self, wa_id: str, text: str, conversation: CloudOrigin, *, quoted: str) -> MessageItem:
        if not self.phone_number_id:
            raise Rejected("this source has no phone_number_id; verify it first")
        payload: dict[str, Any] = {"messaging_product": "whatsapp", "recipient_type": "individual", "to": wa_id, "type": "text", "text": {"body": text}}
        if quoted:
            payload["context"] = {"message_id": quoted}
        body = await self._graph("POST", f"{self.phone_number_id}/messages", json=payload)
        sent_id = str(((body.get("messages") or [{}])[0]).get("id") or "")
        if not sent_id:
            raise OutcomeUnknown("Meta accepted the message but returned no id for it")
        data = WhatsAppMessageData(
            text=text,
            conversation=conversation,
            sender=UserProfile(origin=CloudOrigin(kind="whatsapp", namespace="business", key=self.phone_number_id)),
            sent_at=datetime.now(timezone.utc),
            raw=body,
        )
        return MessageItem(origin=self.message_origin(sent_id, wa_id), data=data)

    # ── transport ───────────────────────────────────────────────────────────
    def _person_of(self, origin: object) -> str:
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        if origin != self.origin(origin.key):
            raise ValueError(f"{origin!r} is outside this source's scope")
        return digits(origin.key)

    def _token(self) -> Optional[str]:
        secret = self.credentials.values.get("access_token")
        return secret.get_secret_value() if secret is not None and secret.get_secret_value() else None

    async def _graph(self, verb: str, path: str, **kwargs: Any) -> dict:
        """One Graph call; Meta's refusal message rides the error."""
        token = self._token()
        if token is None:
            raise AccessDenied("This WhatsApp source has no access token.")
        url, headers = f"{GRAPH_API_BASE}/{GRAPH_VERSION}/{path}", {"Authorization": f"Bearer {token}"}
        refused = (400, 401, 403, 404)
        if self._client is not None:
            response = await http.request(self._client, verb, url, headers=headers, ok_statuses=refused, **kwargs)
        else:
            async with http.client() as client:
                response = await http.request(client, verb, url, headers=headers, ok_statuses=refused, **kwargs)
        try:
            body = response.json() if response.content else {}
        except ValueError as exc:
            raise SourceUnavailable(f"Meta answered {verb} {path} with undecodable JSON") from exc
        if response.status_code >= 400:
            error = (body.get("error") or {}) if isinstance(body, dict) else {}
            message = f"Meta: {error.get('message') or f'HTTP {response.status_code}'}"
            if response.status_code in (401, 403):
                raise AccessDenied(message)
            raise NotFound(message) if response.status_code == 404 else Rejected(message)
        return body if isinstance(body, dict) else {}


def digits(value: Any) -> str:
    """A wa_id is a phone number in international digits — no ``+``, no spaces. Normalised both
    ways, because one number arrives written three ways, and two spellings of one correspondent
    would fork the conversation."""
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _check_outgoing(data: object) -> None:
    if not isinstance(data, MessageData):
        raise TypeError(f"expected MessageData, got {type(data).__name__}")
    if not (data.text or "").strip():
        raise ValueError("a WhatsApp message needs text")
    if data.sender is not None or data.in_reply_to is not None or data.sent_at is not None or data.attachments:
        raise ValueError("sender, in_reply_to, sent_at and attachments are assigned by the provider")


def _text_of(message: dict, kind: str) -> str:
    """The words, whichever shape carried them: a tapped reply button is a person answering."""
    if kind == "text":
        return str((message.get("text") or {}).get("body") or "").strip()
    if kind == "button":
        return str((message.get("button") or {}).get("text") or "").strip()
    interactive = message.get("interactive") or {}
    for shape in ("button_reply", "list_reply"):
        reply = interactive.get(shape) or {}
        if reply.get("title"):
            return str(reply["title"]).strip()
    return ""


def _when(timestamp: Any) -> datetime:
    """Meta sends unix seconds as a STRING."""
    try:
        return datetime.fromtimestamp(int(str(timestamp)), tz=timezone.utc)
    except (TypeError, ValueError):
        return datetime.now(timezone.utc)


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


__all__ = ["GRAPH_API_BASE", "GRAPH_VERSION", "MESSAGES_SEGMENT", "TEXTUAL", "WhatsAppMessageData", "WhatsAppSource", "digits"]
