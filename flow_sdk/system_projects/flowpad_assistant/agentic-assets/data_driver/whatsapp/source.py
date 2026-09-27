"""``WhatsAppSource`` — a business number on Meta's Cloud API.

**Nothing to list.** The Cloud API has no endpoint that lists messages: inbound arrives once, as
a webhook POST from Meta, and if it is dropped it is gone. So this source is not ``Listable``;
``events_from_webhook`` turns Meta's envelope into the contract's events, and the application's
webhook route hands them to its one ingestion chokepoint.

Three more facts:

* **No echo of itself.** Our own outbound comes back only as a delivery ``status``, never as a
  message: what ``send`` returns is the only copy there will be.
* **No threads.** The conversation IS the pair (business number, person), so a conversation's
  key is the person's ``wa_id`` and a message lives in that person's scope —
  ``(whatsapp, <account>/messages/<wa_id>, <wamid>)`` — which is what lets a reply be routed
  from the answered message alone. A quote (``context.id``) is provenance, never membership.
* **The 24-hour window.** A free-form message is allowed only within 24h of the person's last
  one; outside it Meta accepts nothing but an approved template. An answer is inside the window
  by construction, so this sends plain text and lets Meta's own refusal surface when it is not.

Files and reactions:

* **A file is a media handle.** Inbound media arrives as an id, never bytes; the file's origin is
  ``(whatsapp, <account>/media, <media id>)`` — a stream of its own, so a media id can never be
  read as a message id — and ``open`` trades the id for a short-lived download link and reads it.
  Outbound, the bytes are uploaded to ``/media`` first and the message names the returned id; one
  file per message, the caption on the file.
* **A reaction is state, not a message.** It names the reacted message by its wamid in the same
  person's scope as the message itself, so it lands on the row that message was ingested under
  (ours included — a reaction to our reply names our wamid). One emoji per person: a new one
  replaces the old, and a removal carries no emoji at all.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Annotated, Any, AsyncGenerator, AsyncIterator, ClassVar, Mapping, Optional, Union

import httpx
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
from flow_sdk.sources.files import LOCAL_KIND, FileSupport, read_file
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

#: Graph's base — the default when the config's ``base_url`` is empty; a test points it at a loopback double.
GRAPH_API_BASE = "https://graph.facebook.com"
#: Pinned: Meta versions the whole surface and deprecates on a schedule, so the version is a fact
#: about this source, not a default to inherit from whatever Meta serves today.
GRAPH_VERSION = "v23.0"
#: A source is ABOUT one business number, and every conversation arrives through one webhook.
MESSAGES_STREAM = "messages"
#: Message types that are sentences someone wrote; a reaction or a system notice is not.
TEXTUAL = frozenset({"text", "button", "interactive"})
#: Where a media handle lives: beside the messages, never among them.
MEDIA_STREAM = "media"
#: Where a reaction report is keyed (by the wamid of the reaction itself).
REACTIONS_STREAM = "reactions"
#: Meta's message ``type`` for a file, by what the recipient's app shows. A voice note is an ``audio``
#: whose bytes are OGG/Opus — Meta tells them apart by the codec, and reports ``voice: true`` inbound.
WIRE_TYPE: dict[FileKind, str] = {
    FileKind.IMAGE: "image",
    FileKind.VIDEO: "video",
    FileKind.AUDIO: "audio",
    FileKind.VOICE: "audio",
    FileKind.DOCUMENT: "document",
    FileKind.STICKER: "sticker",
}
#: The inbound message types that carry a file, and the kind each is shown as.
MEDIA_TYPES: dict[str, FileKind] = {
    "image": FileKind.IMAGE,
    "video": FileKind.VIDEO,
    "audio": FileKind.AUDIO,
    "document": FileKind.DOCUMENT,
    "sticker": FileKind.STICKER,
}


class WhatsAppMessageData(MessageData):
    spec_kind: ClassVar[str] = "ingest.message.whatsapp"
    volatile: ClassVar[frozenset[str]] = frozenset({"raw"})

    raw: Optional[dict] = None


class WhatsAppConfig(SourceConfig):
    """What a whatsapp source is configured with. Its secrets are the credential in auth, never here."""

    phone_number_id: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    #: Any string you choose, pasted into Meta's webhook setup — it proves the callback URL is yours.
    verify_token: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    #: Where Graph is. Empty means Meta's own host; a test names a loopback double. Never a secret.
    base_url: str = ""


class WhatsAppSource(MessageSource):

    Config = WhatsAppConfig
    provider = "whatsapp"
    identity_config_key = "phone_number_id"
    #: Meta's documented media limits (Cloud API "Supported media types").
    files = FileSupport(
        kinds=frozenset(FileKind),
        per_message=1,
        max_bytes={
            FileKind.IMAGE: 5_000_000,
            FileKind.VIDEO: 16_000_000,
            FileKind.AUDIO: 16_000_000,
            FileKind.VOICE: 16_000_000,
            FileKind.DOCUMENT: 100_000_000,
            FileKind.STICKER: 500_000,
        },
        caption_max=1024,
        caption_kinds=frozenset({FileKind.IMAGE, FileKind.VIDEO, FileKind.DOCUMENT}),
    )
    quotes = True
    reactions_per_actor = 1

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._client: Any = None

    @property
    def phone_number_id(self) -> str:
        return str(self.config.get("phone_number_id") or "").strip()

    @property
    def base_url(self) -> str:
        return str(self.config.get("base_url") or GRAPH_API_BASE).rstrip("/")

    def origin(self, key: str, *within: str) -> CloudOrigin:
        return super().origin(key, *(within or (MESSAGES_STREAM,)))

    def conversation_origin(self, wa_id: str) -> CloudOrigin:
        """The person, who is the conversation."""
        return self.origin(wa_id)

    def message_origin(self, message_id: str, wa_id: str) -> CloudOrigin:
        return self.origin(message_id, MESSAGES_STREAM, wa_id)

    def media_origin(self, media_id: str) -> CloudOrigin:
        """A media handle: Meta's media id, account-wide (a download needs nothing but the id)."""
        return self.origin(media_id, MEDIA_STREAM)

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

    @classmethod
    def webhook_authentic(cls, headers: Mapping[str, str], body: bytes, credentials: ResolvedSecrets) -> bool:
        """Meta's ``X-Hub-Signature-256: sha256=<hex hmac of the raw body>`` under the app secret. A row
        with no app secret accepts nothing."""
        import hashlib  # noqa: PLC0415
        import hmac  # noqa: PLC0415

        stored = credentials.values.get("app_secret")
        secret = stored.get_secret_value() if stored is not None else ""
        offered = str(headers.get("x-hub-signature-256") or "")
        if not secret or not offered:
            return False
        return hmac.compare_digest("sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest(), offered)

    async def _open(self) -> None:
        self._client = http.client()

    async def _close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

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

    def _item(self, message: dict, names: dict[str, str]) -> Union[MessageItem, ReactionItem, None]:
        message_id, wa_id, kind = str(message.get("id") or "").strip(), digits(message.get("from")), str(message.get("type") or "")
        if not (message_id and wa_id):
            return None
        sender = UserProfile(origin=self.conversation_origin(wa_id), name=names.get(wa_id) or None)
        if kind == "reaction":
            return self._reaction(message, message_id, wa_id, sender)
        text = _text_of(message, kind) if kind in TEXTUAL else ""
        files = tuple(f for f in (self._file(message, kind),) if f is not None)
        if not (text or files):
            return None
        quoted = str((message.get("context") or {}).get("id") or "")
        data = WhatsAppMessageData(
            text=text or None,
            conversation=self.conversation_origin(wa_id),
            sender=sender,
            sent_at=_when(message.get("timestamp")),
            attachments=files,
            in_reply_to=self.message_origin(quoted, wa_id) if quoted else None,
            raw=message,
        )
        return MessageItem(origin=self.message_origin(message_id, wa_id), data=data)

    def _file(self, message: dict, kind: str) -> Optional[FileItem]:
        """The file a media message carries, as its handle; the words on it are its caption."""
        media = message.get(kind) if kind in MEDIA_TYPES else None
        if not isinstance(media, dict) or not str(media.get("id") or "").strip():
            return None
        as_ = FileKind.VOICE if kind == "audio" and media.get("voice") else MEDIA_TYPES[kind]
        data = MessageFileData(
            name=str(media.get("filename") or "").strip() or None,
            media_type=str(media.get("mime_type") or "").strip() or None,
            as_=as_,
            caption=str(media.get("caption") or "").strip() or None,
            sha256=str(media.get("sha256") or "").strip() or None,
        )
        return FileItem(origin=self.media_origin(str(media["id"]).strip()), data=data)

    def _reaction(self, message: dict, message_id: str, wa_id: str, sender: UserProfile) -> Optional[ReactionItem]:
        """The person's one emoji on a message, now; a removal omits ``emoji`` and says ``()``."""
        reaction = message.get("reaction") if isinstance(message.get("reaction"), dict) else {}
        target = str(reaction.get("message_id") or "").strip()
        if not target:
            return None
        emoji = str(reaction.get("emoji") or "")
        data = ReactionData(
            target=self.message_origin(target, wa_id),
            sender=sender,
            emojis=(emoji,) if emoji else (),
            mode=ReactionMode.SET,
            sent_at=_when(message.get("timestamp")),
        )
        return ReactionItem(origin=self.origin(message_id, REACTIONS_STREAM, wa_id), data=data)

    # ── the bytes of an inbound file ────────────────────────────────────────
    def open(self, file: FileItem, *, chunk_size: int = 65536):
        """A media id is traded for a download link (valid minutes), and the link is read with the same
        token. An expired id is Meta's 404 — ``NotFound``."""
        self._require_open()
        return self._download(file, chunk_size)

    @asynccontextmanager
    async def _download(self, file: FileItem, chunk_size: int) -> AsyncGenerator[AsyncIterator[bytes], None]:
        origin = file.origin
        if origin != self.media_origin(origin.key):
            raise ValueError(f"{origin!r} is not a WhatsApp media handle of this source")
        link = str((await self._graph("GET", origin.key)).get("url") or "")
        if not link:
            raise NotFound("Meta has no download link for this media", origin=origin)
        headers = {"Authorization": f"Bearer {self._token()}"}
        try:
            async with self._client.stream("GET", link, headers=headers) as response:
                if response.status_code >= 400:
                    raise http.error_for_status(response.status_code, "Meta: media download", origin=origin)
                yield response.aiter_bytes(chunk_size)
        except httpx.HTTPError as exc:
            raise SourceUnavailable(f"GET media {origin.key}: {exc}", origin=origin) from exc

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
        _check_outgoing(data, self.files)
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
        return await self._send(wa_id, data, conversation, quoted="")

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data, self.files)
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        wa_id = self._person_of_message(origin)
        sent = await self._send(wa_id, data, self.conversation_origin(wa_id), quoted=origin.key)
        return MessageItem(origin=sent.origin, data=sent.data.model_copy(update={"in_reply_to": origin}))

    async def _send(self, wa_id: str, data: MessageData, conversation: CloudOrigin, *, quoted: str) -> MessageItem:
        if not self.phone_number_id:
            raise Rejected("this source has no phone_number_id; verify it first")
        payload: dict[str, Any] = {"messaging_product": "whatsapp", "recipient_type": "individual", "to": wa_id}
        if data.attachments:
            payload.update(await self._media_message(data.attachments[0], data.text))
        else:
            payload.update({"type": "text", "text": {"body": data.text or ""}})
        if quoted:
            payload["context"] = {"message_id": quoted}
        body = await self._graph("POST", f"{self.phone_number_id}/messages", json=payload)
        sent_id = str(((body.get("messages") or [{}])[0]).get("id") or "")
        if not sent_id:
            raise OutcomeUnknown("Meta accepted the message but returned no id for it")
        data = WhatsAppMessageData(
            text=data.text,
            attachments=data.attachments,
            conversation=conversation,
            sender=UserProfile(origin=CloudOrigin(kind="whatsapp", namespace="business", key=self.phone_number_id)),
            sent_at=datetime.now(timezone.utc),
            raw=body,
        )
        return MessageItem(origin=self.message_origin(sent_id, wa_id), data=data)

    async def _media_message(self, file: FileItem, text: Optional[str]) -> dict:
        """Upload the bytes, then the message names the media id Meta answered with."""
        fd = file.data
        media_type = fd.media_type or "application/octet-stream"
        content = await asyncio.to_thread(read_file, file)
        uploaded = await self._graph(
            "POST",
            f"{self.phone_number_id}/media",
            data={"messaging_product": "whatsapp", "type": media_type},
            files={"file": (fd.name or "file", content, media_type)},
        )
        media_id = str(uploaded.get("id") or "")
        if not media_id:
            raise OutcomeUnknown("Meta accepted the upload but returned no media id")
        wire = WIRE_TYPE[fd.as_]
        media: dict[str, Any] = {"id": media_id}
        caption = fd.caption or (text or "").strip()
        if caption:
            media["caption"] = caption
        if fd.as_ is FileKind.DOCUMENT and fd.name:
            media["filename"] = fd.name
        return {"type": wire, wire: media}

    # ── reactions ───────────────────────────────────────────────────────────
    async def react(self, target: CloudOrigin, emoji: str) -> None:
        """Our one emoji on ``target``; a second replaces the first (Meta keeps one per person)."""
        self._require_open()
        if not emoji:
            raise ValueError("react needs an emoji; unreact takes ours back")
        await self._react(target, emoji)

    async def unreact(self, target: CloudOrigin, emoji: str = "") -> None:
        """Take ours back. We hold at most one, so whichever ``emoji`` is named, the one goes."""
        self._require_open()
        await self._react(target, "")

    async def _react(self, target: CloudOrigin, emoji: str) -> None:
        if not self.phone_number_id:
            raise Rejected("this source has no phone_number_id; verify it first")
        wa_id = self._person_of_message(target)
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": wa_id,
            "type": "reaction",
            "reaction": {"message_id": target.key, "emoji": emoji},
        }
        await self._graph("POST", f"{self.phone_number_id}/messages", json=payload)

    # ── transport ───────────────────────────────────────────────────────────
    def _person_of_message(self, origin: object) -> str:
        """The wa_id a message origin hangs off — its conversation's person."""
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        base = self.origin("-").namespace
        if origin.kind != self._scope.kind or not (origin.namespace == base or origin.namespace.startswith(base + "/")):
            raise ValueError(f"{origin!r} is outside this source's scope")
        wa_id = digits(origin.namespace[len(base) + 1:]) if origin.namespace != base else ""
        if not wa_id:
            raise NotFound(f"{origin!r} names no message", origin=origin)
        return wa_id

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
        url, headers = f"{self.base_url}/{GRAPH_VERSION}/{path}", {"Authorization": f"Bearer {token}"}
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


def _check_outgoing(data: object, support: FileSupport) -> None:
    """Text or one local file of a kind WhatsApp shows; the provider's fields left empty. Before any I/O."""
    if not isinstance(data, MessageData):
        raise TypeError(f"expected MessageData, got {type(data).__name__}")
    if data.sender is not None or data.in_reply_to is not None or data.sent_at is not None:
        raise ValueError("sender, in_reply_to and sent_at are assigned by the provider")
    if not data.attachments:
        if not (data.text or "").strip():
            raise ValueError("a WhatsApp message needs text or a file")
        return
    if len(data.attachments) > support.per_message:
        raise ValueError("a WhatsApp message carries one file; send the others as messages of their own")
    for f in data.attachments:
        fd = f.data
        if f.origin.kind != LOCAL_KIND or not isinstance(fd, MessageFileData) or not fd.path:
            raise ValueError(f"an outgoing file must be a local file with a path, got {f.origin!r}")
        if fd.as_ not in support.kinds:
            raise ValueError(f"WhatsApp does not send a {fd.as_.value}")
        if fd.as_ is FileKind.VOICE and not (fd.media_type or "").lower().startswith("audio/ogg"):
            raise ValueError(
                f"a WhatsApp voice note must be OGG/Opus (audio/ogg); {fd.name or 'this file'} is {fd.media_type or 'of no known type'}. "
                "Convert it (ffmpeg -i in -c:a libopus out.ogg) or send it with as_='audio'."
            )
        text = (data.text or "").strip()
        if text and fd.caption:
            raise ValueError("a captioned file carries no text of its own; send the words as a message of their own")
        if (fd.caption or text) and not support.captions(fd.as_):
            raise ValueError(f"WhatsApp shows no caption on a {fd.as_.value}; send the words as a message of their own")


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


__all__ = [
    "GRAPH_API_BASE",
    "GRAPH_VERSION",
    "MEDIA_STREAM",
    "MESSAGES_STREAM",
    "REACTIONS_STREAM",
    "TEXTUAL",
    "WhatsAppMessageData",
    "WhatsAppSource",
    "digits",
]
