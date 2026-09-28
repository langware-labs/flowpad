"""The ``telegram`` source's case in the data source matrix, and the ``Double`` it is built on: a
Bot API over a loopback socket whose update queue a test can feed after the source exists."""
from __future__ import annotations

import json
import time
from contextlib import contextmanager
from typing import Optional

from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets

from .test_telegram_source import CHAT, MEDIA_METHODS, TOKEN, _Bot

#: The ``Message`` field a delivered file rides in, per ``as_``.
_FIELD = {"image": "photo", "video": "video", "audio": "audio", "voice": "voice", "document": "document", "sticker": "sticker"}

#: Where a fresh queue starts; a delivery always lands above every offset the bot was ever asked for.
FIRST_UPDATE_ID = 900001


class Double:
    """telegram as a test double: a loopback Bot API, an inbound you can inject, the outbound it saw."""

    provider = "telegram"

    #: The stranger who writes in: a chat id.
    sender = "665945020"

    def __init__(self):
        self.bot = _Bot()
        self.config: dict = {}
        self.fields: dict = {"account_key": "@my_bot"}
        self.secrets: dict = {"bot_token": TOKEN}
        self._sent: list[dict] = []
        self._reactions: list[dict] = []
        self._server = None

    def __enter__(self) -> "Double":
        self._server = local_http_server(self._respond)
        self.config = {"base_url": self._server.__enter__()}
        return self

    def __exit__(self, *exc):
        server, self._server = self._server, None
        if server is not None:
            server.__exit__(*exc)

    async def credentials(self, _row):
        """The in-process stand-in for ``DataDriver.credentials_for``: the manifest's ``bot_token`` var."""
        return ResolvedSecrets(shape=AuthShape.SECRETS, values={k: SecretStr(v) for k, v in self.secrets.items()})

    def deliver(
        self,
        text: str,
        *,
        sender: str,
        thread: Optional[str] = None,
        files: Optional[list[dict]] = None,
        reply_to: Optional[str] = None,
    ) -> dict:
        """A message from chat ``sender`` arriving now, queued for the next ``getUpdates``. ``thread``
        as ``<chat>/<topic>`` puts it in a forum topic. The chat becomes one the bot may reply to.

        ``files`` (``{name, media_type, as_, bytes, caption}``) ride the message the way Telegram
        carries them — one media field, the text as its caption — and their bytes are then served by
        ``getFile``. Telegram carries one file per message: a second is refused. ``reply_to`` (a
        message id, or ``<chat>/<id>``) makes it quote that message."""
        chat_id = str(sender)
        message_id = self.bot.mint_id()
        message: dict = {
            "message_id": message_id,
            "date": int(time.time()),
            "chat": {"id": _num(chat_id), "type": "private", "first_name": f"user {chat_id}"},
            "from": {"id": _num(chat_id), "first_name": f"user {chat_id}"},
            "text": text,
        }
        topic = str(thread or "").split("/", 1)[1:]
        if topic and topic[0].isdigit():
            message["chat"].update(type="supergroup", is_forum=True, title=f"chat {chat_id}")
            message["message_thread_id"] = int(topic[0])
        if files:
            if len(files) > 1:
                raise ValueError("a Telegram message carries one file")
            (f,) = files
            field = _FIELD[str(f.get("as_") or "document")]
            ext = str(f.get("name") or "").rsplit(".", 1)[-1] or "bin"
            held = self.bot.hold(bytes(f["bytes"]), ext=ext)
            media = {**held, "file_name": f.get("name"), "mime_type": f.get("media_type")}
            message[field] = [{**held, "width": 640, "height": 480}] if field == "photo" else media
            message.pop("text")
            if f.get("caption") or text:
                message["caption"] = f.get("caption") or text
        if reply_to:
            message["reply_to_message"] = {"message_id": int(str(reply_to).rsplit("/", 1)[-1])}
        self.bot.updates.append({"update_id": self._next_update_id(), "message": message})
        self.bot.chats.add(chat_id)
        return {"external_id": str(message_id), "thread": chat_id}

    def react(self, target: str, emoji: str, sender: str) -> dict:
        """Chat ``sender``'s reaction on ``target`` (``<chat>/<id>``, or an id in the sender's chat),
        queued as a ``message_reaction`` update. ``""`` takes it back: Telegram reports the whole new set."""
        chat_id, _, message_id = str(target).rpartition("/")
        chat_id = chat_id or str(sender)
        report = {
            "chat": {"id": _num(chat_id), "type": "private"},
            "message_id": int(message_id),
            "user": {"id": _num(str(sender)), "first_name": f"user {sender}"},
            "date": int(time.time()),
            "old_reaction": [],
            "new_reaction": [{"type": "emoji", "emoji": emoji}] if emoji else [],
        }
        self.bot.updates.append({"update_id": self._next_update_id(), "message_reaction": report})
        return {"target": f"{chat_id}/{message_id}", "emoji": emoji}

    def sent(self) -> list[dict]:
        """Every message the bot sent (text or a file), oldest first. ``files`` holds what an upload
        carried: ``{name, media_type, as_, bytes}``; a file's caption is its ``text``."""
        return list(self._sent)

    def reactions(self) -> list[dict]:
        """Every ``setMessageReaction`` the bot made: ``{target, emojis}`` — ``[]`` is a take-back."""
        return list(self._reactions)

    # ── internals ───────────────────────────────────────────────────────────
    def _next_update_id(self) -> int:
        """Above the queue's last update AND above every offset a poll acknowledged: a source that
        already committed ``offset:N`` must see a delivery queued afterwards on its next fetch."""
        queued = max((u["update_id"] for u in self.bot.updates), default=FIRST_UPDATE_ID - 1)
        acked = max((int(p.get("offset") or 0) for m, p in self.bot.requests if m == "getUpdates"), default=0)
        return max(queued, acked - 1) + 1

    def _respond(self, path, headers):
        uploads = len(self.bot.uploads)
        status, body, response_headers = self.bot(path, headers)
        method = path.partition("?")[0].rsplit("/", 1)[-1]
        if status != 200:
            return status, body, response_headers
        if method == "sendMessage" or method in MEDIA_METHODS:
            result = json.loads(body).get("result") or {}
            files = []
            if method in MEDIA_METHODS and len(self.bot.uploads) > uploads:
                field = MEDIA_METHODS[method]
                name, media_type, data = self.bot.uploads[-1][2][field]
                files.append({"name": name, "media_type": media_type, "as_": {v: k for k, v in _FIELD.items()}[field], "bytes": data})
            self._sent.append({
                "to": str(result["chat"]["id"]),
                "text": result.get("text", result.get("caption", "")),
                "thread": (result.get("reply_to_message") or {}).get("message_id"),
                "external_id": str(result["message_id"]),
                "files": files,
            })
        elif method == "setMessageReaction":
            asked = self.bot.bodies[-1]
            self._reactions.append({
                "target": f"{asked['chat_id']}/{asked['message_id']}",
                "emojis": [r.get("emoji") for r in asked.get("reaction") or []],
            })
        return status, body, response_headers


def _num(chat_id: str) -> int | str:
    return int(chat_id) if chat_id.lstrip("-").isdigit() else chat_id


@contextmanager
def case(monkeypatch, tmp_path):
    with Double() as double:
        monkeypatch.setattr(DataDriver.loaded("telegram"), "credentials_for", double.credentials)
        double.deliver("hello bot", sender=CHAT)
        yield {
            "config": double.config,
            "fields": double.fields,
            "min_items": 1,
            "send": {"to": CHAT, "text": "matrix send"},
            "double": double,
        }
