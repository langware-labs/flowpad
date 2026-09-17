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
from flow_sdk.sources.credentials import AuthShape, Credentials

from .test_telegram_source import CHAT, TOKEN, _Bot

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
        return Credentials(shape=AuthShape.SECRETS, values={k: SecretStr(v) for k, v in self.secrets.items()})

    def deliver(self, text: str, *, sender: str, thread: Optional[str] = None) -> dict:
        """A message from chat ``sender`` arriving now, queued for the next ``getUpdates``. ``thread``
        as ``<chat>/<topic>`` puts it in a forum topic. The chat becomes one the bot may reply to."""
        chat_id = str(sender)
        message_id, self.bot.next_id = self.bot.next_id, self.bot.next_id + 1
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
        self.bot.updates.append({"update_id": self._next_update_id(), "message": message})
        self.bot.chats.add(chat_id)
        return {"external_id": str(message_id), "thread": chat_id}

    def sent(self) -> list[dict]:
        """Every ``sendMessage`` the bot accepted, oldest first."""
        return list(self._sent)

    # ── internals ───────────────────────────────────────────────────────────
    def _next_update_id(self) -> int:
        """Above the queue's last update AND above every offset a poll acknowledged: a source that
        already committed ``offset:N`` must see a delivery queued afterwards on its next fetch."""
        queued = max((u["update_id"] for u in self.bot.updates), default=FIRST_UPDATE_ID - 1)
        acked = max((int(p.get("offset") or 0) for m, p in self.bot.requests if m == "getUpdates"), default=0)
        return max(queued, acked - 1) + 1

    def _respond(self, path, headers):
        status, body, response_headers = self.bot(path, headers)
        if path.rsplit("/", 1)[-1].partition("?")[0] == "sendMessage" and status == 200:
            result = json.loads(body).get("result") or {}
            self._sent.append({
                "to": str(result["chat"]["id"]),
                "text": result.get("text", ""),
                "thread": (result.get("reply_to_message") or {}).get("message_id"),
                "external_id": str(result["message_id"]),
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
