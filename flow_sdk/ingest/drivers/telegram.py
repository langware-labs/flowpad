"""Telegram — the agent's bot account, over the Bot API.

A standard message source "as is": the same driver seam, digest gate and inbox
projection as every other channel. What Telegram changes is the transport
shape, and the code respects exactly three facts about it:

* ``getUpdates`` is a destructive, offset-acked queue. The offset we pass is
  derived ONLY from the committed cursor state, so the provider-side ack
  automatically mirrors the DB: a fetch whose ingest never committed re-reads
  the same updates next cycle. No separate ack bookkeeping.
* A bot never receives its own messages, so nothing will ever echo a sent
  copy back through ``fetch``. ``send`` therefore records the sent message
  itself from the ``sendMessage`` response (``recorded=True``) — without that,
  conversations would show only their inbound half.
* ``message_id`` is unique per chat only, so ``external_id`` is
  ``"<chat_id>/<message_id>"``. The chat is the thread (``thread_key`` is the
  chat id; forum topics extend it with the topic id).

Config on the DataSource::

    {"bot_token": "123456:ABC-...",       # provider-opaque, like api_key
     "base_url": "https://api.telegram.org"}
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest import http
from flow_sdk.ingest.driver import (
    FetchResult,
    IngestDriver,
    SegmentCursorView,
    SegmentRef,
    SendOutcome,
    SendStatus,
)
from flow_sdk.ingest.health import SourceError

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.telegram.org"

#: One page per fetch; the committed offset does the rest.
PAGE_LIMIT = 100

#: Telegram's hard cap for one ``sendMessage`` text.
MAX_TEXT_LEN = 4096

#: The queue is one stream, not per-chat: this is the single segment's key.
UPDATES_SEGMENT = "updates"


def _display_name(user: dict) -> str:
    """A human label for a Telegram user object — username first, else name."""
    username = str(user.get("username") or "").strip()
    if username:
        return f"@{username}"
    parts = [str(user.get("first_name") or ""), str(user.get("last_name") or "")]
    return " ".join(p for p in parts if p).strip() or str(user.get("id") or "")


def _chat_label(chat: dict) -> str:
    """The conversation's own name: a group's title, a DM partner's name."""
    title = str(chat.get("title") or "").strip()
    return title or _display_name(chat)


class TelegramDriver(IngestDriver):
    provider = "telegram"
    kind = "datasource.api.telegram"
    #: A chat message, same kind as Slack's — the channel differs, the record
    #: does not.
    record_kind = "content.message.chat"
    sends = True
    #: The config field that names WHICH account this source serves — what
    #: ``blocks.Inbox`` matches on when reusing a source.
    identity_config_key = "bot_token"

    def channel_for(self, source) -> str:
        return "telegram"

    # ── fetch ────────────────────────────────────────────────────────────────

    async def segments(self, source) -> list[SegmentRef]:
        self._token(source)  # config sanity before the poller commits a slot
        return [SegmentRef(UPDATES_SEGMENT, "updates")]

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        params: dict[str, Any] = {"timeout": 0, "limit": PAGE_LIMIT}
        offset = int((cursor.state or {}).get("next_offset") or 0)
        if offset:
            # Passing the committed offset is what acknowledges (discards)
            # everything below it on Telegram's side — the ack IS the cursor.
            params["offset"] = offset

        payload = await self._call(source, "getUpdates", params=params)
        updates = payload.get("result") or []

        await self._ensure_identity(source)

        items: list[SourceItemSpec] = []
        max_update_id = offset - 1
        high_water = str((cursor.state or {}).get("high_water") or "")
        for update in updates:
            update_id = int(update.get("update_id") or 0)
            if update_id > max_update_id:
                max_update_id = update_id
            # v1 ingests plain new messages only. Edits, channel posts and
            # callback queries are consumed (their update_id still advances the
            # offset — leaving them would wedge the queue) but not recorded.
            msg = update.get("message")
            if not isinstance(msg, dict):
                continue
            item = self._to_item(source, msg)
            if item is None:
                continue
            items.append(item)
            if item.occurred_at and item.occurred_at > high_water:
                high_water = item.occurred_at

        state = dict(cursor.state or {})
        if max_update_id >= offset:
            state["next_offset"] = max_update_id + 1
        if high_water:
            state["high_water"] = high_water
        return FetchResult(
            items=items,
            next_state=state,
            high_water=high_water or None,
            unchanged=not updates,
        )

    def _to_item(self, source, msg: dict) -> Optional[SourceItemSpec]:
        """One Telegram ``Message`` → the shared envelope. ``None`` for a
        message with no chat/message identity (never seen in practice, but a
        blank natural-key component must not reach the ingestor)."""
        chat = msg.get("chat") or {}
        chat_id = str(chat.get("id") or "")
        message_id = str(msg.get("message_id") or "")
        if not chat_id or not message_id:
            return None
        sender = msg.get("from") or {}
        thread_key = chat_id
        topic_id = str(msg.get("message_thread_id") or "")
        if topic_id and bool(chat.get("is_forum")):
            thread_key = f"{chat_id}/{topic_id}"
        occurred = None
        if msg.get("date"):
            occurred = datetime.fromtimestamp(int(msg["date"]), tz=timezone.utc).isoformat()
        return SourceItemSpec(
            data_source_id=source.id,
            provider=self.provider,
            kind=self.record_kind,
            segment_key=UPDATES_SEGMENT,
            external_id=f"{chat_id}/{message_id}",
            name=_chat_label(chat),
            body=str(msg.get("text") or msg.get("caption") or ""),
            occurred_at=occurred,
            author_external_id=str(sender.get("id") or "") or None,
            author_display=_display_name(sender) or None,
            thread_key=thread_key,
            reply_to_external_id=(
                f"{chat_id}/{(msg.get('reply_to_message') or {}).get('message_id')}"
                if (msg.get("reply_to_message") or {}).get("message_id")
                else None
            ),
        )

    # ── send ─────────────────────────────────────────────────────────────────

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
        """Deliver, for real, and record the sent copy ourselves.

        The chat is the address: ``to`` carries the chat id (``thread_key``'s
        leading component is the fallback), and ``in_reply_to`` — this
        driver's ``"<chat_id>/<message_id>"`` external id — quotes the
        replied-to message. ``subject`` has no Telegram equivalent and is
        ignored by design, not smuggled into the text.
        """
        if len(text) > MAX_TEXT_LEN:
            # Never truncate someone's words silently; the caller decides how
            # to split. (Telegram would reject it anyway — this error is ours
            # and readable.)
            # ValueError, not SourceError: a bad reply must never park the
            # source (see the send contract in ``IngestDriver``).
            raise ValueError(f"telegram caps a message at {MAX_TEXT_LEN} chars, got {len(text)}")
        chat_id = str(to or "").strip() or str(thread_key or "").split("/", 1)[0].strip()
        if not chat_id:
            raise ValueError("a telegram send needs a chat id in `to` or `thread_key`")

        body: dict[str, Any] = {"chat_id": chat_id, "text": text}
        reply_msg_id = str(in_reply_to or "").rsplit("/", 1)[-1].strip()
        if reply_msg_id.isdigit():
            body["reply_to_message_id"] = int(reply_msg_id)
        topic_id = str(thread_key or "").split("/", 1)[1:]
        if topic_id and topic_id[0].isdigit():
            body["message_thread_id"] = int(topic_id[0])

        payload = await self._call(source, "sendMessage", json_body=body)
        sent = payload.get("result") or {}

        # A bot NEVER receives its own messages through getUpdates, so no
        # later poll will echo this — the response is the only copy we will
        # ever see, and recording it here is what keeps our half of the
        # conversation in its thread.
        recorded = False
        item = self._to_item(source, sent)
        if item is not None:
            try:
                from flow_sdk.ingest.ingestor import ingest_items  # noqa: PLC0415

                await ingest_items([item])
                recorded = True
            except Exception:  # noqa: BLE001 — the mail IS delivered; bookkeeping must not unsend it
                logger.exception("[telegram] sent %s but could not record the copy", item.external_id)

        return SendOutcome(
            external_id=(
                f"{(sent.get('chat') or {}).get('id')}/{sent.get('message_id')}"
                if sent.get("message_id")
                else ""
            ),
            status=SendStatus.SENT,
            recorded=recorded,
        )

    # ── identity ─────────────────────────────────────────────────────────────

    async def _ensure_identity(self, source) -> None:
        """Stamp the bot's own ids onto the source, once.

        ``self_addresses``/agent-sender attribution reads
        ``account_identities``; without the bot's user id there, the sent
        copies this driver records would attribute as a foreign sender.
        Stamped on the first successful fetch — before any send can exist.
        """
        if getattr(source, "account_key", "") or getattr(source, "account_identities", None):
            return
        try:
            me = (await self._call(source, "getMe")).get("result") or {}
            username = str(me.get("username") or "").strip()
            bot_id = str(me.get("id") or "").strip()
            if not (username or bot_id):
                return
            source.account_key = f"@{username}" if username else bot_id
            source.account_identities = [v for v in (bot_id, f"@{username}" if username else "") if v]
            await source.save()
        except Exception:  # noqa: BLE001 — identity is a nicety; fetching must not fail on it
            logger.debug("[telegram] getMe identity stamp failed", exc_info=True)

    # ── HTTP ─────────────────────────────────────────────────────────────────

    @staticmethod
    def _token(source) -> str:
        token = str((source.config or {}).get("bot_token") or "").strip()
        if not token:
            raise SourceError.config("no_bot_token", "config.bot_token is required")
        return token

    @staticmethod
    def _base(source) -> str:
        return str((source.config or {}).get("base_url") or DEFAULT_BASE_URL).rstrip("/")

    async def _call(
        self, source, method: str, *, params: Optional[dict] = None, json_body: Optional[dict] = None
    ) -> dict:
        """One Bot API call. Telegram wraps everything in ``{ok, result}`` and
        reports errors as ``{ok: false, description}`` — surfaced as a
        SourceError with the description, never with the token (which lives in
        the URL path and must not leak into messages)."""
        url = f"{self._base(source)}/bot{self._token(source)}/{method}"
        payload = await http.request_json(
            None,
            "POST" if json_body is not None else "GET",
            url,
            params=params,
            json=json_body,
            hint=f"telegram {method}",
        )
        if not isinstance(payload, dict) or not payload.get("ok"):
            desc = str((payload or {}).get("description") or "") if isinstance(payload, dict) else ""
            raise SourceError.transient("telegram_api", f"{method}: {desc or 'not ok'}")
        return payload
