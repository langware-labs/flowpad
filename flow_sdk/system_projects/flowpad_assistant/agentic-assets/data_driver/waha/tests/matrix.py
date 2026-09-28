"""The ``waha`` source's case in the data source matrix: inbound arrives as a signed WAHA delivery,
outbound goes to a loopback WAHA. The session is this run's own, so a delivery can only match the
row the matrix made."""
from __future__ import annotations

import base64
import json
import time
import uuid
from contextlib import contextmanager

from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets

from . import test_waha_source as t


@contextmanager
def case(monkeypatch, tmp_path):
    session = f"matrix{uuid.uuid4().hex[:12]}"

    monkeypatch.setattr(t, "SESSION", session)
    with local_http_server(t._Waha()) as base:
        values = {k: SecretStr(v) for k, v in {**t.SECRETS, "base_url": base}.items()}

        async def credential(_row):  # the waha credential, never config — this run's WAHA included
            return ResolvedSecrets(shape=AuthShape.SECRETS, values=values)

        monkeypatch.setattr(DataDriver.loaded("waha"), "credentials_for", credential)
        yield {
            "config": {"session": session},
            "push": t._delivery(t._message("true_x_MATRIX1", "hello from waha", timestamp=int(time.time())), session=session),
            "sign": lambda raw: {"X-Webhook-Hmac": t.sign(raw)},
            "min_items": 1,
            "send": {"to": t.PHONE, "text": "matrix send"},
        }


WEBHOOK_PATH = "/api/v1/data_source/webhook/waha"
#: The engine's name for how a file was sent (WEBJS ``_data.type``), by the contract's kind.
_WEBJS_TYPE = {"image": "image", "video": "video", "audio": "audio", "voice": "ptt", "document": "document", "sticker": "sticker"}
#: What each send route carries, as the contract's kind (``sendFile`` carries audio, documents and stickers).
_ROUTE_KIND = {"/api/sendImage": "image", "/api/sendVideo": "video", "/api/sendVoice": "voice", "/api/sendFile": "file"}


class Double:
    """waha as a test double: a loopback WAHA whose session is this run's own, a signed webhook
    delivery you can inject (a message, its files, a quote, a reaction), and what it saw go out —
    sends with their inline bytes, and reactions.

    A delivery is NOT posted by the Double — WAHA posts to whichever backend is being tested, so
    ``deliver`` hands back the exact bytes and their signature, and the caller POSTs."""

    provider = "waha"

    #: The person who writes in: a phone number (their chat is ``<number>@c.us``).
    sender = t.PHONE

    def __init__(self):
        self.session = f"matrix{uuid.uuid4().hex[:12]}"
        self.waha = t._Waha()
        self.config: dict = {}
        self.fields: dict = {}
        self.secrets = dict(t.SECRETS)
        self._server = None
        self._delivered = 0

    def __enter__(self) -> "Double":
        self._server = local_http_server(self.waha)
        # Where this double answers is a credential value (WAHA_BASE_URL), planted with the keys.
        self.secrets["base_url"] = self._server.__enter__()
        self.config = {"session": self.session}
        return self

    def __exit__(self, *exc):
        if self._server is not None:
            self._server.__exit__(*exc)
            self._server = None

    async def credentials(self, _row) -> ResolvedSecrets:
        return ResolvedSecrets(shape=AuthShape.SECRETS, values={k: SecretStr(v) for k, v in self.secrets.items()})

    def pair(self) -> None:
        """The phone scans the QR that verify left the session waiting on: the session is WORKING."""
        self.waha.status = "WORKING"

    def deliver(self, text: str, *, sender: str, thread=None, files: list[dict] | None = None, reply_to: str | None = None) -> dict:
        """A message from ``sender`` arriving now; the caller POSTs ``body`` with ``headers`` to ``path``.

        ``files`` (``[{name, media_type, as_, bytes, caption}]``) make it a media message — WhatsApp
        carries one file each, so only the first is delivered, with ``text`` as its caption when it has
        none; WAHA holds its bytes under ``/api/files/...`` and reports them on its OWN host, as the
        real container does. ``reply_to`` quotes that message."""
        chat = self._chat(sender)
        message_id = self._id(chat)
        extra: dict = {"timestamp": int(time.time())}
        if reply_to:
            extra["replyTo"] = {"id": reply_to}
        body = text
        if files:
            f = files[0]
            path = f"/api/files/{self.session}/{message_id}"
            media_type = str(f.get("media_type") or "application/octet-stream")
            self.waha.files[path] = (bytes(f.get("bytes") or b""), media_type)
            body = f.get("caption") or text
            extra.update(hasMedia=True, media={"url": f"{t.WAHA_OWN_HOST}{path}", "mimetype": media_type, "filename": f.get("name"), "error": None},
                         _data={"type": _WEBJS_TYPE[str(f.get("as_") or "document")]})
        return self._post(t._message(message_id, body, chat=chat, **extra), chat, "message")

    def react(self, target: str, emoji: str, sender: str) -> dict:
        """``sender`` puts ``emoji`` on message ``target`` (``""`` takes theirs back); a delivery like ``deliver``'s."""
        chat = self._chat(sender)
        reaction = {"id": self._id(chat), "from": chat, "fromMe": False, "timestamp": int(time.time()), "reaction": {"text": emoji, "messageId": target}}
        return self._post(reaction, chat, "message.reaction")

    def _chat(self, sender: str) -> str:
        return f"{sender}@c.us" if str(sender).isdigit() else str(sender)

    def _id(self, chat: str) -> str:
        self._delivered += 1
        return f"false_{chat}_IN{self._delivered}{uuid.uuid4().hex[:6]}"

    def _post(self, payload: dict, chat: str, event: str) -> dict:
        raw = json.dumps(t._delivery(payload, event=event, session=self.session)).encode()
        return {"external_id": payload["id"], "thread": chat, "path": WEBHOOK_PATH, "body": raw,
                "headers": {"X-Webhook-Hmac": t.sign(raw)}}

    def sent(self) -> list[dict]:
        """Every send WAHA accepted, oldest first; ``files`` with the bytes that went inline."""
        out = []
        for method, path, body in self.waha.calls:
            if method != "POST" or not (path == "/api/sendText" or path in _ROUTE_KIND):
                continue
            files = []
            if isinstance(body.get("file"), dict):
                f = body["file"]
                files.append({"as_": _ROUTE_KIND[path], "name": f.get("filename"), "media_type": f.get("mimetype"),
                              "caption": body.get("caption"), "bytes": base64.b64decode(f.get("data") or "")})
            out.append({"to": str(body.get("chatId") or "").split("@")[0], "text": body.get("text"), "thread": body.get("chatId"),
                        "external_id": f"OUT{len(out) + 1}", "reply_to": body.get("reply_to"), "files": files})
        return out

    def reactions(self) -> list[dict]:
        """Every reaction we put (``emoji``) or took back (``""``), oldest first."""
        return [
            {"target": body.get("messageId"), "emoji": body.get("reaction")}
            for method, path, body in self.waha.calls
            if (method, path) == ("PUT", "/api/reaction")
        ]
