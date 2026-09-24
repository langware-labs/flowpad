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

The token lives in the request path, so an error message never carries it.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, AsyncGenerator, ClassVar, Mapping, Optional

from flow_sdk.sources import http
from flow_sdk.sources.base import Source, positive_int
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
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage

DEFAULT_BASE_URL = "https://api.telegram.org"
#: Updates per page; the committed offset does the rest.
PAGE_LIMIT = 100
#: Telegram's hard cap for one ``sendMessage`` text.
MAX_TEXT_LEN = 4096
#: The queue is one stream, not per-chat: every origin is scoped under it.
UPDATES_STREAM = "updates"
_OFFSET = "offset:"


class TelegramMessageData(MessageData):
    spec_kind: ClassVar[str] = "ingest.message.telegram"

    #: The chat's own name — a group's title, a direct partner's name.
    title: Optional[str] = None


class TelegramConfig(SourceConfig):
    """What a telegram source is configured with. Its secrets are the credential in auth, never here."""

    base_url: str = ""


class TelegramSource(Source):

    Config = TelegramConfig
    provider = "telegram"
    durable_cursor = True
    page_size = PAGE_LIMIT
    #: The token names WHICH bot a row serves — what a caller matches to reuse a source.
    #: The bot is named by getMe, not by a config field: its token is a credential.
    identity_config_key = ""
    #: Chat-grade while watched: the Bot API is comfortable at one getUpdates every few seconds.
    attention_poll_seconds = 5

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
        params: dict[str, Any] = {"timeout": 0, "limit": limit}
        if offset:
            # Passing the committed offset is what acknowledges (discards) everything below it.
            params["offset"] = offset
        updates = await self._call("getUpdates", params=params) or []
        ids = [int(update.get("update_id") or 0) for update in updates]
        after = max(ids) + 1 if ids else offset
        items = tuple(
            item for update in updates if isinstance(update.get("message"), dict) and (item := self._item(update["message"])) is not None
        )
        return ChangePage(
            items=items,
            next_cursor=self.resume_at(after) if len(updates) >= limit else None,
            resume_cursor=self.resume_at(after) if after else None,
        )

    async def iterate(
        self, *, page_size: Optional[int] = None, narrow: Optional[Mapping[str, Any]] = None
    ) -> AsyncGenerator[MessageItem, None]:
        cursor: Optional[str] = None
        while True:
            page = await self.fetch(cursor, page_size=page_size, narrow=narrow)
            for item in page.items:
                yield item
            if (cursor := page.next_cursor) is None:
                return

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
        )
        return MessageItem(origin=self.origin(f"{chat_id}/{message_id}"), data=data)

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
        _check_outgoing(data)
        if (data.conversation is None) == (not data.recipients):
            raise ValueError("address exactly one of a conversation or recipients")
        if data.conversation is not None:
            chat, _, topic = self._key_of(data.conversation).partition("/")
            return await self._send(chat, topic, data.text or "", data.conversation)
        if len(data.recipients) != 1:
            raise Unsupported("a Telegram message goes to exactly one chat")
        chat = data.recipients[0].origin.key
        return await self._send(chat, "", data.text or "", self.chat_origin(chat))

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        chat, _, message_id = self._key_of(origin).partition("/")
        if not message_id.isdigit():
            raise NotFound(f"{origin!r} names no message", origin=origin)
        return await self._send(chat, "", data.text or "", None, reply_to=int(message_id))

    async def _send(self, chat: str, topic: str, text: str, conversation: Optional[CloudOrigin], *, reply_to: int = 0) -> MessageItem:
        body: dict[str, Any] = {"chat_id": chat, "text": text}
        if reply_to:
            body["reply_to_message_id"] = reply_to
        if topic.isdigit():
            body["message_thread_id"] = int(topic)
        result = await self._call("sendMessage", json_body=body)
        item = self._item(result) if isinstance(result, dict) else None
        if item is None:
            raise OutcomeUnknown("Telegram accepted the message but returned no identity for it")
        return item if conversation is None else MessageItem(origin=item.origin, data=item.data.model_copy(update={"conversation": conversation}))

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

    async def _call(self, method: str, *, params: Optional[dict] = None, json_body: Optional[dict] = None) -> Any:
        """One Bot API call. Everything comes wrapped in ``{ok, result}``; a refusal is
        ``{ok: false, error_code, description}``. The token is scrubbed from every message."""
        token = self._token()
        verb, url = ("POST" if json_body is not None else "GET"), f"{self.base_url}/bot{token}/{method}"
        try:
            if self._client is not None:
                response = await http.request(self._client, verb, url, params=params, json=json_body, ok_statuses=(400, 403, 429))
            else:
                async with http.client() as client:
                    response = await http.request(client, verb, url, params=params, json=json_body, ok_statuses=(400, 403, 429))
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


def _check_outgoing(data: object) -> None:
    if not isinstance(data, MessageData):
        raise TypeError(f"expected MessageData, got {type(data).__name__}")
    text = data.text or ""
    if not text.strip():
        raise ValueError("a Telegram message needs text")
    if len(text) > MAX_TEXT_LEN:
        # Never truncate someone's words silently; the caller decides how to split.
        raise ValueError(f"telegram caps a message at {MAX_TEXT_LEN} chars, got {len(text)}")
    if data.sender is not None or data.in_reply_to is not None or data.sent_at is not None or data.attachments:
        raise ValueError("sender, in_reply_to, sent_at and attachments are assigned by the provider")


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


__all__ = ["DEFAULT_BASE_URL", "MAX_TEXT_LEN", "PAGE_LIMIT", "TelegramMessageData", "TelegramSource"]
