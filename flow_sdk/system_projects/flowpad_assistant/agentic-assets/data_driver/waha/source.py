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
* **No echo of itself.** The session subscribes to ``message`` and ``message.reaction`` — never
  ``message.any`` — and ``fromMe`` is dropped besides, so the agent cannot answer its own replies.
* **Signed deliveries.** WAHA signs each body with the key as ``X-Webhook-Hmac`` (hex HMAC-SHA512).

Files and reactions:

* **A file's handle is where WAHA keeps it.** WAHA downloads inbound media itself and reports a URL
  on ITS host (``http://localhost:3000/api/files/<session>/<id>.<ext>``), which is rarely where this
  machine reaches it. The file's origin key is that URL's path — ``(whatsapp, <account>/media,
  /api/files/...)``, a stream of its own, named after the message id — and ``open`` reads the path
  from the configured ``WAHA_BASE_URL`` with the API key. Media WAHA did not download (no URL) is
  kept as metadata with its ``fetch_error``.
* **A reaction is state, not a message.** It names the reacted message by the same serialized id the
  message is keyed by, in the same chat, so it lands on that row. One emoji per person; ``""``
  takes it back.
"""
from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Annotated, Any, AsyncGenerator, AsyncIterator, ClassVar, Mapping, Optional
from urllib.parse import urlsplit

from pydantic import StringConstraints

from flow_sdk.sources import http
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.credentials import ResolvedSecrets
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
from flow_sdk.sources.files import FileSupport, check_files, kind_of, read_file
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.values.event import DataSourceEvent, EventKind
from flow_sdk.sources.values.items import (
    FileItem,
    FileKind,
    MessageData,
    MessageFileData,
    MessageItem,
    ReactionData,
    ReactionItem,
    ReactionMode,
    UserProfile,
)
from flow_sdk.sources.values.origin import CloudOrigin

#: One number, one webhook: every conversation is a chat under it.
MESSAGES_STREAM = "messages"
#: The events the session subscribes to. ``message.any`` would echo our own sends.
WEBHOOK_EVENTS = ("message", "message.reaction")
#: Where a media handle lives: beside the messages, never among them.
MEDIA_STREAM = "media"
#: Where a reaction report is keyed (by the id of the reaction itself).
REACTIONS_STREAM = "reactions"
#: The send route per kind. A voice note is converted to OGG/Opus by WAHA (``convert``); audio, a
#: document and a sticker go as a file.
SEND_ROUTE: dict[FileKind, str] = {
    FileKind.IMAGE: "/api/sendImage",
    FileKind.VIDEO: "/api/sendVideo",
    FileKind.VOICE: "/api/sendVoice",
    FileKind.AUDIO: "/api/sendFile",
    FileKind.DOCUMENT: "/api/sendFile",
    FileKind.STICKER: "/api/sendFile",
}
#: How the engines name a message's media (WEBJS ``_data.type``; NOWEB the key under ``_data.message``).
WEBJS_KINDS = {"image": FileKind.IMAGE, "video": FileKind.VIDEO, "audio": FileKind.AUDIO, "ptt": FileKind.VOICE, "document": FileKind.DOCUMENT, "sticker": FileKind.STICKER}
NOWEB_KINDS = {
    "imageMessage": FileKind.IMAGE,
    "videoMessage": FileKind.VIDEO,
    "audioMessage": FileKind.AUDIO,
    "documentMessage": FileKind.DOCUMENT,
    "documentWithCaptionMessage": FileKind.DOCUMENT,
    "stickerMessage": FileKind.STICKER,
}
#: Chat-id suffixes that name a phone number, so the sender key can be its digits.
PHONE_SUFFIXES = ("@c.us", "@s.whatsapp.net")
#: Statuses WAHA answers with a JSON message worth quoting, so the call reads the body before raising.
_REFUSED = (400, 401, 403, 404, 422)


class WahaMessageData(MessageData):
    spec_kind: ClassVar[str] = "ingest.message.waha"
    volatile: ClassVar[frozenset[str]] = frozenset({"raw"})

    raw: Optional[dict] = None


class WahaConfig(SourceConfig):
    """What a waha source is configured with — what is true wherever the repo goes. Where the container
    answers and how it reaches this instance differ per machine: they are the ``waha`` credential's
    ``WAHA_BASE_URL`` / ``WAHA_WEBHOOK_URL``, read per deployment."""

    session: str = "default"
    #: Who may drive the number; the row keeps it as ``allowed_senders``.
    allowed_senders: list[Annotated[str, StringConstraints(pattern=r"^([0-9]+|[^@\s]+@lid)$")]] = []


class WahaSource(MessageSource):

    Config = WahaConfig
    provider = "waha"
    #: The same channel as the Cloud API source: one WhatsApp, whichever transport carries it.
    origin_kind = "whatsapp"
    identity_config_key = "session"
    #: WhatsApp's own limits hold whichever client carries them; WAHA adds none we know of.
    files = FileSupport(
        kinds=frozenset(FileKind),
        per_message=1,
        caption_max=1024,
        caption_kinds=frozenset({FileKind.IMAGE, FileKind.VIDEO, FileKind.DOCUMENT}),
    )
    quotes = True
    reactions_per_actor = 1

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._client: Any = None

    @property
    def base_url(self) -> str:
        return (self._secret("base_url") or "").strip().rstrip("/")

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

    def media_origin(self, key: str) -> CloudOrigin:
        """A media handle: the path WAHA serves it at (or, when it served none, ``<message id>:media``)."""
        return self.origin(key, MEDIA_STREAM)

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
    def webhook_authentic(cls, headers: Mapping[str, str], body: bytes, credentials: ResolvedSecrets) -> bool:
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
        message = payload.get("payload")
        item = self._reaction(message) if payload.get("event") == "message.reaction" else self._item(message)
        return [DataSourceEvent(id=item.origin.key, kind=EventKind.UPSERT, origin=item.origin, item=item)] if item else []

    @staticmethod
    def _theirs(message: Any) -> tuple[str, str]:
        """``(id, chat)`` of a delivery someone else wrote in a one-to-one chat; empty otherwise."""
        if not isinstance(message, dict) or message.get("fromMe"):
            return "", ""
        message_id, chat = str(message.get("id") or "").strip(), str(message.get("from") or "").strip()
        return ("", "") if chat.endswith("@g.us") else (message_id, chat)

    def _sender(self, message: dict, chat: str) -> UserProfile:
        extra = message.get("_data") if isinstance(message.get("_data"), dict) else {}
        name = str(extra.get("notifyName") or extra.get("pushName") or "") or None
        return UserProfile(origin=self.origin(sender_key(phone_chat(extra, chat))), name=name)

    def _item(self, message: Any) -> Optional[MessageItem]:
        message_id, chat = self._theirs(message)
        if not (message_id and chat):
            return None
        text = str(message.get("body") or "").strip()
        files = (self._file(message, message_id, caption=text),) if message.get("hasMedia") else ()
        if not (text or files):
            return None
        reply_to = message.get("replyTo")
        quoted = str(reply_to.get("id") or "") if isinstance(reply_to, dict) else ""
        data = WahaMessageData(
            text=text or None,  # a media message's body is its words, and rides the file as its caption too
            conversation=self.conversation_origin(chat),
            sender=self._sender(message, chat),
            sent_at=_when(message.get("timestamp")),
            attachments=files,
            in_reply_to=self.message_origin(quoted, chat) if quoted else None,
            raw=message,
        )
        return MessageItem(origin=self.message_origin(message_id, chat), data=data)

    def _file(self, message: dict, message_id: str, *, caption: str) -> FileItem:
        media = message.get("media") if isinstance(message.get("media"), dict) else {}
        media_type = str(media.get("mimetype") or "").strip() or None
        url = str(media.get("url") or "").strip()
        path = urlsplit(url)._replace(scheme="", netloc="").geturl() if url else ""
        error = media.get("error")
        missing = None
        if not path:
            missing = f"WAHA did not download this media: {error}" if error else "WAHA did not download this media (no URL)"
        data = MessageFileData(
            name=str(media.get("filename") or "").strip() or None,
            media_type=media_type,
            as_=_kind_of(message, media_type),
            caption=caption or None,
            fetch_error=missing,
        )
        return FileItem(origin=self.media_origin(path or f"{message_id}:media"), data=data)

    def _reaction(self, message: Any) -> Optional[ReactionItem]:
        """``{id, from, reaction: {text, messageId}}``: this person's one emoji on that message now."""
        reaction_id, chat = self._theirs(message)
        reaction = message.get("reaction") if reaction_id and isinstance(message.get("reaction"), dict) else {}
        target = str(reaction.get("messageId") or "").strip()
        if not (reaction_id and chat and target):
            return None
        emoji = str(reaction.get("text") or "")
        data = ReactionData(
            target=self.message_origin(target, _chat_of_id(target) or chat),
            sender=self._sender(message, chat),
            emojis=(emoji,) if emoji else (),
            mode=ReactionMode.SET,
            sent_at=_when(message.get("timestamp")),
        )
        return ReactionItem(origin=self.origin(reaction_id, REACTIONS_STREAM, chat), data=data)

    # ── the bytes of an inbound file ────────────────────────────────────────
    def open(self, file: FileItem, *, chunk_size: int = 65536):
        """GET the media's path from WHERE THIS MACHINE REACHES WAHA — the host WAHA reported is its own."""
        self._require_open()
        return self._download(file, chunk_size)

    @asynccontextmanager
    async def _download(self, file: FileItem, chunk_size: int) -> AsyncGenerator[AsyncIterator[bytes], None]:
        origin = file.origin
        if origin != self.media_origin(origin.key) or not origin.key.startswith("/"):
            raise ValueError(f"{origin!r} is not a WAHA media file of this source")
        key = self._secret("api_key")
        if key is None:
            raise AccessDenied("This WAHA source has no API key.")
        url = f"{self.base_url}{origin.key}"
        async with http.stream(self._client, url, headers={"X-Api-Key": key}, hint="WAHA: media download", origin=origin, chunk_size=chunk_size) as chunks:
            yield chunks

    # ── setup ───────────────────────────────────────────────────────────────
    async def verify(self) -> Verdict:
        """The session exists with this instance's webhook, and the phone is paired. Creating or
        re-pointing the session is part of verifying it: a person never configures WAHA by hand."""
        if not self.base_url:
            return Verdict(ready=False, detail="No WAHA URL here — set WAHA_BASE_URL (where the container answers): flow credentials set waha")
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
        ours = [h for h in hooks if isinstance(h, dict) and h.get("url") == webhook["url"]]
        # Re-pointed when it calls elsewhere, and when it calls here for other events (an older
        # instance's subscription predates reactions).
        if not any(set(h.get("events") or ()) == set(WEBHOOK_EVENTS) for h in ours):
            session = await self._api("PUT", f"/api/sessions/{self.session}", json={"config": {**(session.get("config") or {}), "webhooks": [webhook]}})
        if str(session.get("status") or "") in ("STOPPED", "FAILED"):
            session = await self._api("POST", f"/api/sessions/{self.session}/start")
        return session

    async def teardown(self) -> str:
        """Remove THIS instance's webhook from the WAHA session -- only the entry whose URL is this machine's
        (``WAHA_WEBHOOK_URL``); the session, its pairing and every other webhook stay."""
        url = (self._secret("webhook_url") or "").strip()
        if not url or not self.base_url:
            return ""
        try:
            session = await self._api("GET", f"/api/sessions/{self.session}")
        except NotFound:
            return ""
        config = session.get("config") if isinstance(session.get("config"), dict) else {}
        hooks = [h for h in (config.get("webhooks") or []) if isinstance(h, dict)]
        kept = [h for h in hooks if h.get("url") != url]
        if len(kept) == len(hooks):
            return ""
        await self._api("PUT", f"/api/sessions/{self.session}", json={"config": {**config, "webhooks": kept}})
        return f"removed its webhook from WAHA session {self.session}"

    def _webhook(self) -> dict:
        url = (self._secret("webhook_url") or "").strip()
        if not url:
            raise Rejected("no WAHA webhook URL here — set WAHA_WEBHOOK_URL (how WAHA reaches this instance): flow credentials set waha")
        hook: dict[str, Any] = {"url": url, "events": list(WEBHOOK_EVENTS)}
        key = self._secret("webhook_hmac")
        if key:
            hook["hmac"] = {"key": key}
        return hook

    # ── send ────────────────────────────────────────────────────────────────
    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data, self.files)
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
        return await self._send(chat, data, conversation, quoted="")

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data, self.files)
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        chat = self._chat_of_message(origin)
        sent = await self._send(chat, data, self.conversation_origin(chat), quoted=origin.key)
        return MessageItem(origin=sent.origin, data=sent.data.model_copy(update={"in_reply_to": origin}))

    async def _send(self, chat: str, data: MessageData, conversation: CloudOrigin, *, quoted: str) -> MessageItem:
        payload: dict[str, Any] = {"session": self.session, "chatId": chat}
        route = "/api/sendText"
        if data.attachments:
            file = data.attachments[0]
            route = SEND_ROUTE[file.data.as_]
            payload.update(await _media_body(file, data.text))
        else:
            payload["text"] = data.text or ""
        if quoted:
            payload["reply_to"] = quoted
        body = await self._api("POST", route, json=payload)
        sent_id = _id_of(body)
        if not sent_id:
            raise OutcomeUnknown("WAHA accepted the message but returned no id for it")
        me = str(self.binding.account_key or self.session)
        data = WahaMessageData(
            text=data.text,
            attachments=data.attachments,
            conversation=conversation,
            sender=UserProfile(origin=CloudOrigin(kind="whatsapp", namespace="account", key=me)),
            sent_at=datetime.now(timezone.utc),
            raw=body,
        )
        return MessageItem(origin=self.message_origin(sent_id, chat), data=data)

    # ── reactions ───────────────────────────────────────────────────────────
    async def react(self, target: CloudOrigin, emoji: str) -> None:
        """Our one emoji on ``target``; a second replaces the first."""
        self._require_open()
        if not emoji:
            raise ValueError("react needs an emoji; unreact takes ours back")
        await self._react(target, emoji)

    async def unreact(self, target: CloudOrigin, emoji: str = "") -> None:
        """Take ours back. We hold at most one, so whichever ``emoji`` is named, the one goes."""
        self._require_open()
        await self._react(target, "")

    async def _react(self, target: CloudOrigin, emoji: str) -> None:
        self._chat_of_message(target)
        await self._api("PUT", "/api/reaction", json={"session": self.session, "messageId": target.key, "reaction": emoji})

    # ── transport ───────────────────────────────────────────────────────────
    def _chat_of_message(self, origin: object) -> str:
        """The chat a message origin hangs off."""
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        chat = self._chat_from(origin)
        if not chat:
            raise NotFound(f"{origin!r} names no message", origin=origin)
        return chat

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


def _chat_of_id(message_id: str) -> str:
    """The chat a message someone else wrote was keyed under, read from its serialized id
    (``false_<chat>_<id>``) — exactly the ``from`` it arrived with, whichever way (``@lid`` or
    ``@c.us``) the reaction's own ``from`` names the person. "" for our own messages and bare ids."""
    fields = message_id.split("_")
    return fields[1] if len(fields) >= 3 and fields[0] == "false" and "@" in fields[1] else ""


def _kind_of(message: dict, media_type: Optional[str]) -> FileKind:
    """What the sender's app sent it as — the engine says (a voice note, a sticker, an image sent as a
    document); the media type decides only when it does not."""
    extra = message.get("_data") if isinstance(message.get("_data"), dict) else {}
    named = WEBJS_KINDS.get(str(extra.get("type") or ""))
    if named is not None:
        return named
    inner = extra.get("message") if isinstance(extra.get("message"), dict) else {}
    for field, kind in NOWEB_KINDS.items():
        if isinstance(inner.get(field), dict):
            return FileKind.VOICE if kind is FileKind.AUDIO and inner[field].get("ptt") else kind
    return kind_of(media_type or "")


async def _media_body(file: FileItem, text: Optional[str]) -> dict:
    """The file inline, base64 — WAHA takes the bytes in the body, not by upload."""
    fd = file.data
    content = await asyncio.to_thread(read_file, file)
    body: dict[str, Any] = {
        "file": {"mimetype": fd.media_type or "application/octet-stream", "filename": fd.name or "file", "data": base64.b64encode(content).decode()}
    }
    caption = fd.caption or (text or "").strip()
    if caption:
        body["caption"] = caption
    if fd.as_ in (FileKind.VOICE, FileKind.VIDEO):
        body["convert"] = True  # WhatsApp plays only OGG/Opus voice and MP4/H.264 video; WAHA transcodes
    return body


def _check_outgoing(data: object, support: FileSupport) -> None:
    """Text or one local file of a kind WhatsApp shows; the provider's fields left empty. Before any I/O."""
    if not isinstance(data, MessageData):
        raise TypeError(f"expected MessageData, got {type(data).__name__}")
    if data.sender is not None or data.in_reply_to is not None or data.sent_at is not None:
        raise ValueError("sender, in_reply_to and sent_at are assigned by the provider")
    if not data.attachments and not (data.text or "").strip():
        raise ValueError("a WhatsApp message needs text or a file")
    check_files(data.attachments, support, title="WhatsApp", text=data.text)
    text = (data.text or "").strip()
    for f in data.attachments:
        if text and f.data.caption:
            raise ValueError("a captioned file carries no text of its own; send the words as a message of their own")
        if text and not support.captions(f.data.as_):
            raise ValueError(f"WhatsApp shows no caption on a {f.data.as_.value}; send the words as a message of their own")


def _when(timestamp: Any) -> datetime:
    """Unix seconds — or milliseconds, which one engine sends."""
    try:
        value = int(float(str(timestamp)))
    except (TypeError, ValueError):
        return datetime.now(timezone.utc)
    return datetime.fromtimestamp(value / 1000 if value > 10**12 else value, tz=timezone.utc)


__all__ = ["MEDIA_STREAM", "MESSAGES_STREAM", "REACTIONS_STREAM", "WEBHOOK_EVENTS", "WahaMessageData", "WahaSource", "chat_id", "digits", "sender_key"]
