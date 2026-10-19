"""``TelegramSource`` — a bot account over the Bot API, as a message source.

Three Telegram facts shape it:

* ``getUpdates`` is a destructive, offset-acknowledged queue. The offset a traversal passes is
  its cursor; the resume cursor is the offset after the last update seen. An application that
  persists it only after committing what it read re-reads the same updates when it did not, so
  the acknowledgement mirrors the commit with no bookkeeping of its own. Updates that are not
  messages (edits, callbacks) still advance the offset: left unacknowledged they wedge the queue.
* A bot never receives its own messages: what ``send`` returns is the
  only copy of it there will ever be, and the send path records it.
* ``message_id`` is unique per chat only, so a message's key is ``<chat_id>/<message_id>``. The
  chat is the conversation; a forum topic narrows it to ``<chat_id>/<topic_id>``.

A file on a message is keyed by its ``file_id`` — the handle ``getFile`` resolves — in the ``files``
scope beside the update stream (``<account>/files``). A reaction report is a ``message_reaction``
update, keyed ``reaction:<update_id>``, whose target is the reacted message's own origin.

The token lives in the request path, so an error message never carries it.
"""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, AsyncIterator, ClassVar, Mapping, Optional

from flow_sdk.sources import http
from flow_sdk.sources.base import positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.errors import (
    AccessDenied,
    InvalidCursor,
    NotFound,
    OutcomeUnknown,
    Rejected,
    SourceError,
    SourceUnavailable,
    Unsupported,
)
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.files import FileSupport, check_files, extension_of, normalize_emoji, read_file
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
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage

from .reactions import ALLOWED_EMOJI

DEFAULT_BASE_URL = "https://api.telegram.org"
#: Updates per page; the committed offset does the rest.
PAGE_LIMIT = 100
#: Telegram's hard cap for one ``sendMessage`` text.
MAX_TEXT_LEN = 4096
#: The queue is one stream, not per-chat: every origin is scoped under it.
UPDATES_STREAM = "updates"
_OFFSET = "offset:"
#: The scope a file's ``file_id`` is keyed in, beside the update stream.
FILES_SCOPE = "files"
#: What a bot may download through ``getFile``; bigger files stay on Telegram.
MAX_DOWNLOAD_BYTES = 20_000_000
#: The updates the queue delivers. Anything else is never asked for.
ALLOWED_UPDATES = ("message", "message_reaction")
#: The Bot API method and its upload field per kind of file sent.
SEND_METHOD: dict[FileKind, tuple[str, str]] = {
    FileKind.IMAGE: ("sendPhoto", "photo"),
    FileKind.VIDEO: ("sendVideo", "video"),
    FileKind.AUDIO: ("sendAudio", "audio"),
    FileKind.VOICE: ("sendVoice", "voice"),
    FileKind.DOCUMENT: ("sendDocument", "document"),
    FileKind.STICKER: ("sendSticker", "sticker"),
}
_CAPTIONED = frozenset({FileKind.IMAGE, FileKind.VIDEO, FileKind.AUDIO, FileKind.VOICE, FileKind.DOCUMENT})


class TelegramMessageData(MessageData):
    spec_kind: ClassVar[str] = "ingest.message.telegram"

    #: The chat's own name — a group's title, a direct partner's name.
    title: Optional[str] = None


class TelegramConfig(SourceConfig):
    """What a telegram source is configured with. Its secrets are the credential in auth, never here."""

    base_url: str = ""


class TelegramSource(MessageSource):

    Config = TelegramConfig
    provider = "telegram"
    durable_cursor = True
    page_size = PAGE_LIMIT
    #: The token names WHICH bot a row serves — what a caller matches to reuse a source.
    #: The bot is named by getMe, not by a config field: its token is a credential.
    identity_config_key = ""
    #: Chat-grade while watched: the Bot API is comfortable at one getUpdates every few seconds.
    attention_poll_seconds = 5
    #: One file per message; photos upload at 10 MB, everything else at 50 MB (Bot API limits).
    files = FileSupport(
        kinds=frozenset(SEND_METHOD),
        per_message=1,
        max_bytes={kind: 10_000_000 if kind is FileKind.IMAGE else 50_000_000 for kind in SEND_METHOD},
        caption_max=1024,
        caption_kinds=_CAPTIONED,
    )
    quotes = True
    #: A bot keeps one reaction on a message; a new one replaces it.
    reactions_per_actor = 1

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._client: Any = None

    @classmethod
    def resume_at(cls, offset: int) -> str:
        """The cursor that continues the queue at update ``offset``."""
        return f"{_OFFSET}{int(offset)}"

    def origin(self, key: str, *within: str) -> CloudOrigin:
        return super().origin(key, *(within or (UPDATES_STREAM,)))

    def chat_origin(self, chat_id: str, topic: str = "") -> CloudOrigin:
        return self.origin(f"{chat_id}/{topic}" if topic else chat_id)

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def outbound_spec(cls) -> type:
        from flow_sdk.builtin.source_item import TelegramMessageSpec  # noqa: PLC0415

        return TelegramMessageSpec

    def message_for(self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""):
        """``to`` is the chat — a chat reply targets the chat, never its author — and a forum topic
        rides ``thread_key``. ``in_reply_to`` (``<chat_id>/<message_id>``) makes it a reply to that
        message, which Telegram keeps in the replied message's topic. A subject has no equivalent."""
        chat = str(to or "").strip() or str(thread_key or "").split("/", 1)[0].strip()
        if not chat:
            raise ValueError("a telegram send needs a chat id in `to` or `thread_key`")
        answered = str(in_reply_to or "").strip()
        if "/" in answered and answered.rsplit("/", 1)[-1].isdigit():
            return MessageData(text=text), self.origin(answered)
        topic = str(thread_key or "").split("/", 1)[1:]
        return MessageData(text=text, conversation=self.chat_origin(chat, topic[0] if topic and topic[0].isdigit() else "")), None

    @property
    def base_url(self) -> str:
        return str(self.config.get("base_url") or DEFAULT_BASE_URL).rstrip("/")

    async def _open(self) -> None:
        self._client = http.client()

    async def _close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ── read ────────────────────────────────────────────────────────────────
    def query(self) -> None:
        """The update queue is the whole bot: it takes no query, so nothing narrows it."""
        return None

    async def fetch(
        self, cursor: Optional[str] = None, *, page_size: Optional[int] = None, narrow: Optional[Mapping[str, Any]] = None
    ) -> ChangePage:
        self._require_open()
        self.effective_query(narrow)  # the queue takes no query: any narrowing is refused
        limit = min(PAGE_LIMIT if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE), PAGE_LIMIT)
        offset = _offset(cursor)
        params: dict[str, Any] = {"timeout": 0, "limit": limit, "allowed_updates": json.dumps(ALLOWED_UPDATES)}
        if offset:
            # Passing the committed offset is what acknowledges (discards) everything below it.
            params["offset"] = offset
        updates = await self._call("getUpdates", params=params) or []
        ids = [int(update.get("update_id") or 0) for update in updates]
        after = max(ids) + 1 if ids else offset
        items = tuple(item for update in updates if (item := self._update_item(update)) is not None)
        return ChangePage(
            items=items,
            next_cursor=self.resume_at(after) if len(updates) >= limit else None,
            resume_cursor=self.resume_at(after) if after else None,
        )

    async def iterate(
        self, *, page_size: Optional[int] = None, narrow: Optional[Mapping[str, Any]] = None
    ) -> AsyncGenerator[MessageItem | ReactionItem, None]:
        cursor: Optional[str] = None
        while True:
            page = await self.fetch(cursor, page_size=page_size, narrow=narrow)
            for item in page.items:
                yield item
            if (cursor := page.next_cursor) is None:
                return

    def _update_item(self, update: dict) -> Optional[MessageItem | ReactionItem]:
        if isinstance(update.get("message"), dict):
            return self._item(update["message"])
        if isinstance(update.get("message_reaction"), dict):
            return self._reaction(int(update.get("update_id") or 0), update["message_reaction"])
        return None

    def _reaction(self, update_id: int, report: dict) -> Optional[ReactionItem]:
        """A ``MessageReactionUpdated``: the reactor's whole set on the message now — ``()`` when they
        took it back. An anonymous group admin reacts as the chat (``actor_chat``)."""
        chat_id, message_id = str((report.get("chat") or {}).get("id") or ""), str(report.get("message_id") or "")
        actor = report.get("user") or report.get("actor_chat") or {}
        if not update_id or not chat_id or not message_id or not actor.get("id"):
            return None
        name = _display_name(actor) if report.get("user") else _chat_label(actor)
        data = ReactionData(
            target=self.origin(f"{chat_id}/{message_id}"),
            sender=UserProfile(origin=self.origin(str(actor["id"])), name=name or None),
            emojis=tuple(e for r in report.get("new_reaction") or () if (e := _emoji_of(r))),
            mode=ReactionMode.SET,
            sent_at=datetime.fromtimestamp(int(report["date"]), tz=timezone.utc) if report.get("date") else None,
        )
        return ReactionItem(origin=self.origin(f"reaction:{update_id}"), data=data)

    def _item(self, msg: dict) -> Optional[MessageItem]:
        """One ``Message``; ``None`` without a chat and message identity — a blank key component
        must never reach an application."""
        chat = msg.get("chat") or {}
        chat_id, message_id = str(chat.get("id") or ""), str(msg.get("message_id") or "")
        if not chat_id or not message_id:
            return None
        sender = msg.get("from") or {}
        topic = str(msg.get("message_thread_id") or "") if chat.get("is_forum") else ""
        replied = (msg.get("reply_to_message") or {}).get("message_id")
        data = TelegramMessageData(
            text=str(msg.get("text") or msg.get("caption") or ""),
            title=_chat_label(chat) or None,
            conversation=self.chat_origin(chat_id, topic),
            sender=UserProfile(origin=self.origin(str(sender["id"])), name=_display_name(sender) or None) if sender.get("id") else None,
            sent_at=datetime.fromtimestamp(int(msg["date"]), tz=timezone.utc) if msg.get("date") else None,
            in_reply_to=self.origin(f"{chat_id}/{replied}") if replied else None,
            attachments=self._attachments(msg),
        )
        return MessageItem(origin=self.origin(f"{chat_id}/{message_id}"), data=data)

    def _attachments(self, msg: dict) -> tuple[FileItem, ...]:
        """The file a message carries, keyed by its ``file_id``. Metadata only: the runtime copies the
        bytes through ``open`` while the session is open."""
        caption = str(msg.get("caption") or "") or None
        found: list[tuple[FileKind, str, dict, str]] = []
        sizes = [p for p in msg.get("photo") or () if isinstance(p, dict) and p.get("file_id")]
        if sizes:
            # Telegram sends every resolution; the largest is the photo.
            largest = max(sizes, key=lambda p: (int(p.get("file_size") or 0), int(p.get("width") or 0) * int(p.get("height") or 0)))
            found.append((FileKind.IMAGE, "photo", largest, "image/jpeg"))
        for field, kind, default_type in _MEDIA_FIELDS:
            media = msg.get(field)
            if not isinstance(media, dict) or not media.get("file_id"):
                continue
            if field == "document" and isinstance(msg.get("animation"), dict):
                continue  # an animation also rides as its document, for old clients: one file, not two
            if field == "sticker":
                default_type = "application/x-tgsticker" if media.get("is_animated") else "video/webm" if media.get("is_video") else "image/webp"
            found.append((kind, field, media, str(media.get("mime_type") or "") or default_type))
        return tuple(self._file(kind, field, media, media_type, caption) for kind, field, media, media_type in found)

    def _file(self, kind: FileKind, field: str, media: dict, media_type: str, caption: Optional[str]) -> FileItem:
        file_id = str(media["file_id"])
        name = str(media.get("file_name") or "").strip()
        if not name:
            ext = extension_of(media_type) or ".bin"
            name = f"{field}-{media.get('file_unique_id') or file_id}{ext}"
        size = media.get("file_size")
        data = MessageFileData(
            name=name, media_type=media_type, size=int(size) if size is not None else None, as_=kind,
            caption=caption if kind in _CAPTIONED else None,
        )
        return FileItem(origin=self.origin(file_id, FILES_SCOPE), data=data)

    # ── files ───────────────────────────────────────────────────────────────
    def open(self, file: FileItem, *, chunk_size: int = 65536):
        """The bytes of a file a message carried: ``getFile`` names its path, then one download from
        ``/file/bot<token>/<path>``. A bot may download 20 MB at most — a bigger file is refused."""
        self._require_open()
        if not isinstance(file, FileItem) or file.origin != self.origin(file.origin.key, FILES_SCOPE):
            raise ValueError(f"{getattr(file, 'origin', file)!r} is not a file this source handed out")
        return self._download(file, chunk_size)

    @asynccontextmanager
    async def _download(self, file: FileItem, chunk_size: int) -> AsyncIterator[AsyncIterator[bytes]]:
        declared = file.data.size or 0
        if declared > MAX_DOWNLOAD_BYTES:
            raise Unsupported(_TOO_BIG, origin=file.origin)
        try:
            found = await self._call("getFile", params={"file_id": file.origin.key}) or {}
        except Rejected as exc:
            if "too big" in str(exc).lower():
                raise Unsupported(_TOO_BIG, origin=file.origin) from None
            raise
        if int(found.get("file_size") or 0) > MAX_DOWNLOAD_BYTES:
            raise Unsupported(_TOO_BIG, origin=file.origin)
        path = str(found.get("file_path") or "")
        if not path:
            raise NotFound("telegram getFile: no file path", origin=file.origin)
        token = self._token()
        url = f"{self.base_url}/file/bot{token}/{path}"
        async with http.stream(self._client, url, hint="telegram file download", origin=file.origin, chunk_size=chunk_size, redact=token) as chunks:
            yield chunks

    # ── reactions ───────────────────────────────────────────────────────────
    async def react(self, target: CloudOrigin, emoji: str) -> None:
        """Our reaction on ``target``, replacing the one we had: a bot keeps one."""
        self._require_open()
        wanted = normalize_emoji(emoji).strip()
        if not wanted:
            return await self.unreact(target)
        if wanted not in ALLOWED_EMOJI:
            raise Rejected(f"{emoji} is not a reaction a Telegram bot can set", origin=target)
        await self._set_reaction(target, [{"type": "emoji", "emoji": wanted}])

    async def unreact(self, target: CloudOrigin, emoji: str = "") -> None:
        """Take ours back. A bot holds one reaction per message, so there is only ever one to take."""
        self._require_open()
        await self._set_reaction(target, [])

    async def _set_reaction(self, target: CloudOrigin, reaction: list) -> None:
        chat, _, message_id = self._key_of(target).partition("/")
        if not message_id.isdigit():
            raise NotFound(f"{target!r} names no message", origin=target)
        await self._call("setMessageReaction", json_body={"chat_id": chat, "message_id": int(message_id), "reaction": reaction})

    # ── identity ────────────────────────────────────────────────────────────
    async def whoami(self) -> tuple[UserProfile, ...]:
        me = await self._call("getMe") or {}
        bot_id, username = str(me.get("id") or "").strip(), str(me.get("username") or "").strip()
        if not bot_id:
            return ()
        return (UserProfile(origin=CloudOrigin(kind="telegram", namespace="bots", key=bot_id), name=f"@{username}" if username else None),)

    # ── send ────────────────────────────────────────────────────────────────
    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data, self.files)
        if (data.conversation is None) == (not data.recipients):
            raise ValueError("address exactly one of a conversation or recipients")
        if data.conversation is not None:
            chat, _, topic = self._key_of(data.conversation).partition("/")
            return await self._send(chat, topic, data, data.conversation)
        if len(data.recipients) != 1:
            raise Unsupported("a Telegram message goes to exactly one chat")
        chat = data.recipients[0].origin.key
        return await self._send(chat, "", data, self.chat_origin(chat))

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        """A message that quotes ``origin`` (``reply_parameters``), in its chat."""
        self._require_open()
        _check_outgoing(data, self.files)
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        chat, _, message_id = self._key_of(origin).partition("/")
        if not message_id.isdigit():
            raise NotFound(f"{origin!r} names no message", origin=origin)
        return await self._send(chat, "", data, None, reply_to=int(message_id))

    async def _send(self, chat: str, topic: str, data: MessageData, conversation: Optional[CloudOrigin], *, reply_to: int = 0) -> MessageItem:
        """``sendMessage`` for text; for a file, the kind's own method as a multipart upload with the
        text as its caption."""
        body: dict[str, Any] = {"chat_id": chat}
        if reply_to:
            body["reply_parameters"] = {"message_id": reply_to}
        if topic.isdigit():
            body["message_thread_id"] = int(topic)
        sent_file = data.attachments[0] if data.attachments else None
        if sent_file is None:
            result = await self._call("sendMessage", json_body={**body, "text": data.text or ""})
        else:
            fd = sent_file.data
            method, field = SEND_METHOD[fd.as_]
            caption = fd.caption or data.text or ""
            if caption:
                body["caption"] = caption
            form = {k: v if isinstance(v, str) else json.dumps(v) for k, v in body.items()}
            upload = {field: (fd.name or "file", await asyncio.to_thread(read_file, sent_file), fd.media_type or "application/octet-stream")}
            result = await self._call(method, form=form, files=upload)
        item = self._item(result) if isinstance(result, dict) else None
        if item is None:
            raise OutcomeUnknown("Telegram accepted the message but returned no identity for it")
        update: dict[str, Any] = {}
        if conversation is not None:
            update["conversation"] = conversation
        if sent_file is not None:
            update["attachments"] = _as_sent(item.data.attachments, sent_file)
        return item if not update else MessageItem(origin=item.origin, data=item.data.model_copy(update=update))

    # ── transport ───────────────────────────────────────────────────────────
    def _key_of(self, origin: object) -> str:
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        if origin != self.origin(origin.key):
            raise ValueError(f"{origin!r} is outside this source's scope")
        return origin.key

    def _token(self) -> str:
        secret = self.credentials.values.get("bot_token")
        if secret is None or not secret.get_secret_value():
            raise Rejected("A Telegram source needs its bot token.")
        return secret.get_secret_value()

    async def _call(
        self,
        method: str,
        *,
        params: Optional[dict] = None,
        json_body: Optional[dict] = None,
        form: Optional[dict] = None,
        files: Optional[dict] = None,
    ) -> Any:
        """One Bot API call — a JSON body, or a multipart ``form`` with ``files`` for an upload.
        Everything comes wrapped in ``{ok, result}``; a refusal is ``{ok: false, error_code,
        description}``. The token is scrubbed from every message."""
        token = self._token()
        posts = json_body is not None or files is not None
        verb, url = ("POST" if posts else "GET"), f"{self.base_url}/bot{token}/{method}"
        body: dict[str, Any] = {"data": form, "files": files} if files is not None else {"json": json_body}
        try:
            if self._client is not None:
                response = await http.request(self._client, verb, url, params=params, ok_statuses=(400, 403, 429), **body)
            else:
                async with http.client() as client:
                    response = await http.request(client, verb, url, params=params, ok_statuses=(400, 403, 429), **body)
            payload = response.json()
        except SourceError as exc:
            raise type(exc)(f"telegram {method}: {str(exc).replace(token, '<token>')}") from None
        except ValueError:
            raise SourceUnavailable(f"telegram {method}: undecodable response") from None
        if isinstance(payload, dict) and payload.get("ok"):
            return payload.get("result")
        raise _refusal(method, payload if isinstance(payload, dict) else {})


def _refusal(method: str, payload: dict) -> SourceError:
    code, detail = payload.get("error_code"), str(payload.get("description") or "not ok")
    message = f"telegram {method}: {detail}"
    if code == 403:
        return AccessDenied(message)
    if code == 429:
        return SourceUnavailable(message)
    if "not found" in detail.lower():
        return NotFound(message)
    if code == 400:
        return Rejected(message)
    return SourceUnavailable(message)


def _check_outgoing(data: object, support: FileSupport) -> None:
    """Text, or one local file the channel takes. With a file the text is its caption, so it must
    fit one and the file must not carry a caption of its own too."""
    if not isinstance(data, MessageData):
        raise TypeError(f"expected MessageData, got {type(data).__name__}")
    if data.sender is not None or data.in_reply_to is not None or data.sent_at is not None:
        raise ValueError("sender, in_reply_to and sent_at are assigned by the provider")
    text = data.text or ""
    files = data.attachments
    if files and text.strip():
        # With a file the text IS its caption, so it is checked as one.
        if any(getattr(f.data, "caption", None) for f in files):
            raise ValueError("a Telegram file message has one caption: the text or the file's, not both")
        files = tuple(
            f.model_copy(update={"data": f.data.model_copy(update={"caption": text})}) if isinstance(f.data, MessageFileData) else f
            for f in files
        )
    if not files and not text.strip():
        raise ValueError("a Telegram message needs text")
    check_files(files, support, title="Telegram", text=data.text)
    if not files and len(text) > MAX_TEXT_LEN:
        # Never truncate someone's words silently; the caller decides how to split.
        raise ValueError(f"telegram caps a message at {MAX_TEXT_LEN} chars, got {len(text)}")


def _as_sent(mapped: tuple[FileItem, ...], sent: FileItem) -> tuple[FileItem, ...]:
    """The sent file as Telegram named it, still pointing at the bytes we sent — the runtime keeps a
    durable copy of them, and nothing will ever deliver this message back to download."""
    if not mapped:
        return (sent,)
    head = mapped[0]
    return (head.model_copy(update={"data": head.data.model_copy(update={"path": sent.data.path, "name": sent.data.name or head.data.name})}),)


def _emoji_of(reaction: object) -> str:
    """A ``ReactionType`` as the contract carries it: unicode, or ``:<id>:`` for a custom emoji; a paid
    reaction has no emoji and is left out."""
    if not isinstance(reaction, dict):
        return ""
    if reaction.get("type") == "emoji":
        return str(reaction.get("emoji") or "")
    if reaction.get("type") == "custom_emoji" and reaction.get("custom_emoji_id"):
        return f":{reaction['custom_emoji_id']}:"
    return ""


#: ``(message field, kind, media type when Telegram names none)`` — the photo is its own case.
_MEDIA_FIELDS: tuple[tuple[str, FileKind, str], ...] = (
    ("video", FileKind.VIDEO, "video/mp4"),
    ("animation", FileKind.VIDEO, "video/mp4"),
    ("video_note", FileKind.VIDEO, "video/mp4"),
    ("audio", FileKind.AUDIO, "audio/mpeg"),
    ("voice", FileKind.VOICE, "audio/ogg"),
    ("document", FileKind.DOCUMENT, "application/octet-stream"),
    ("sticker", FileKind.STICKER, "image/webp"),
)
_TOO_BIG = "Telegram bots can download 20 MB at most"


def _offset(cursor: object) -> int:
    if cursor is None:
        return 0
    if not isinstance(cursor, str):
        raise TypeError(f"cursor must be a string, got {type(cursor).__name__}")
    value = cursor[len(_OFFSET):] if cursor.startswith(_OFFSET) else ""
    if not value.isdigit():
        raise InvalidCursor("not a Telegram cursor")
    return int(value)


def _display_name(user: dict) -> str:
    """A human label for a Telegram user — username first, else the name."""
    username = str(user.get("username") or "").strip()
    if username:
        return f"@{username}"
    parts = [str(user.get("first_name") or ""), str(user.get("last_name") or "")]
    return " ".join(p for p in parts if p).strip() or str(user.get("id") or "")


def _chat_label(chat: dict) -> str:
    return str(chat.get("title") or "").strip() or _display_name(chat)


__all__ = ["DEFAULT_BASE_URL", "MAX_DOWNLOAD_BYTES", "MAX_TEXT_LEN", "PAGE_LIMIT", "SEND_METHOD", "TelegramMessageData", "TelegramSource"]
