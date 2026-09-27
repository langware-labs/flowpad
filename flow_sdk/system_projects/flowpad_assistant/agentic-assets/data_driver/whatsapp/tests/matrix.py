"""The ``whatsapp`` source's case in the data source matrix, and the ``Double`` behind it: inbound
arrives as a webhook delivery (the Cloud API lists nothing), outbound goes to a loopback Graph. The
business number is the Double's own, so a delivery can only match the row built on its config."""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from contextlib import contextmanager
from typing import Optional

from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets

from .test_whatsapp_source import APP_SECRET, WA_ID, _Graph, _text, _webhook, sign

WEBHOOK_PATH = "/api/v1/data_source/webhook/whatsapp"


class Double:
    """whatsapp as a test double: a loopback Graph, a webhook delivery you can inject (a message, its
    files, a quote, a reaction), and what Graph saw go out — sends with their uploaded bytes, and reactions.

    A delivery is NOT posted by the Double — Meta posts to whichever backend is being tested, so
    ``deliver`` hands back the exact bytes and the signature over them, and the caller POSTs."""

    provider = "whatsapp"

    #: The stranger who writes in: a wa_id.
    sender = "972500000001"

    def __init__(self):
        self.graph = _Graph()
        self.phone_number_id = f"matrix{uuid.uuid4().hex[:12]}"
        self.verify_token = "matrix-token"
        self.config: dict = {}
        self.fields: dict = {}
        self.secrets = {"access_token": "EAAG-test", "app_secret": APP_SECRET}
        self._server = None
        self._delivered = 0

    def __enter__(self) -> "Double":
        self._server = local_http_server(self.graph)
        self.graph.base = self._server.__enter__()
        self.config = {"phone_number_id": self.phone_number_id, "verify_token": self.verify_token, "base_url": self.graph.base}
        return self

    def __exit__(self, *exc):
        if self._server is not None:
            self._server.__exit__(*exc)
            self._server = None

    async def credentials(self, _row) -> ResolvedSecrets:
        """The in-process stand-in for ``DataDriver.credentials_for``: the whatsapp credential, never config."""
        return ResolvedSecrets(shape=AuthShape.SECRETS, values={k: SecretStr(v) for k, v in self.secrets.items()})

    def handshake(self) -> dict:
        """Meta's one-time subscribe query, carrying this Double's verify token."""
        return {"hub.mode": "subscribe", "hub.verify_token": self.verify_token, "hub.challenge": "42"}

    def sign(self, raw: bytes) -> dict:
        return {"X-Hub-Signature-256": sign(raw)}

    def deliver(self, text: str, *, sender: str, thread: Optional[str] = None, files: Optional[list[dict]] = None, reply_to: Optional[str] = None) -> dict:
        """A message from ``sender`` arriving now. The person IS the conversation, so the thread is the
        sender whatever ``thread`` says; the caller POSTs ``body`` with ``headers`` to ``path``.

        ``files`` (``[{name, media_type, as_, bytes, caption}]``) arrive one per message, as WhatsApp
        carries them — ``text`` rides as the first one's caption when it has none; their bytes are held
        for download by media id. ``reply_to`` quotes that message. ``external_id`` is the first message's."""
        context = {"context": {"from": self.phone_number_id, "id": reply_to}} if reply_to else {}
        messages = []
        for i, f in enumerate(files or []):
            messages.append(self._media(f, sender, caption=f.get("caption") or (text if i == 0 else None), **context))
        if not messages:
            self._delivered += 1
            messages.append(_text(f"wamid.{self._delivered}", text, ts=str(int(time.time())), **{"from": sender}, **context))
        raw = self._post(*messages, sender=sender)
        return {"external_id": messages[0]["id"], "thread": sender, "path": WEBHOOK_PATH, "body": raw, "headers": self.sign(raw)}

    def react(self, target: str, emoji: str, sender: str) -> dict:
        """``sender`` puts ``emoji`` on message ``target`` (``""`` takes theirs back); a delivery like ``deliver``'s."""
        self._delivered += 1
        reaction = {"message_id": target, **({"emoji": emoji} if emoji else {})}
        message = {"id": f"wamid.{self._delivered}", "from": sender, "timestamp": str(int(time.time())), "type": "reaction", "reaction": reaction}
        raw = self._post(message, sender=sender)
        return {"external_id": message["id"], "thread": sender, "path": WEBHOOK_PATH, "body": raw, "headers": self.sign(raw)}

    def _media(self, f: dict, sender: str, *, caption: Optional[str], **context) -> dict:
        self._delivered += 1
        content, media_type, as_ = bytes(f.get("bytes") or b""), str(f.get("media_type") or "application/octet-stream"), str(f.get("as_") or "document")
        media_id = f"media{self._delivered}{uuid.uuid4().hex[:6]}"
        self.graph.media[media_id] = (content, media_type)
        wire = "audio" if as_ == "voice" else as_
        media: dict = {"id": media_id, "mime_type": media_type, "sha256": hashlib.sha256(content).hexdigest()}
        if as_ == "voice":
            media["voice"] = True
        if caption and wire in ("image", "video", "document"):
            media["caption"] = caption
        if wire == "document" and f.get("name"):
            media["filename"] = f["name"]
        return {"id": f"wamid.{self._delivered}", "from": sender, "timestamp": str(int(time.time())), "type": wire, wire: media, **context}

    def _post(self, *messages: dict, sender: str) -> bytes:
        payload = _webhook(*messages, contacts=[{"wa_id": sender, "profile": {"name": f"Person {sender}"}}], phone_number_id=self.phone_number_id)
        return json.dumps(payload).encode()

    def _messages(self) -> list[tuple[int, dict]]:
        """Every ``/messages`` POST with the id Graph answered it with, oldest first."""
        out, n = [], 0
        for path, body in zip(self.graph.requests, self.graph.bodies):
            if path.split("?")[0].endswith("/messages") and body:
                n += 1
                out.append((n, json.loads(body)))
        return out

    def sent(self) -> list[dict]:
        """Every message Graph accepted, oldest first; ``files`` with the bytes that were uploaded for them."""
        uploads = {media_id: fields for media_id, fields in self.graph.uploads}
        out = []
        for n, sent in self._messages():
            kind = sent.get("type")
            if kind == "reaction":
                continue
            files = []
            if kind != "text" and isinstance(sent.get(kind), dict):
                media = sent[kind]
                name, media_type, content = (uploads.get(media.get("id")) or {}).get("file", (None, None, b""))
                files.append({"as_": kind, "name": media.get("filename") or name, "media_type": media_type, "caption": media.get("caption"), "bytes": content})
            out.append({"to": sent.get("to"), "text": (sent.get("text") or {}).get("body"), "thread": (sent.get("context") or {}).get("message_id"),
                        "external_id": f"wamid.OUT{n}", "files": files})
        return out

    def reactions(self) -> list[dict]:
        """Every reaction we put (``emoji``) or took back (``""``), oldest first."""
        return [
            {"to": sent.get("to"), "target": sent["reaction"].get("message_id"), "emoji": sent["reaction"].get("emoji", "")}
            for _, sent in self._messages()
            if sent.get("type") == "reaction"
        ]


@contextmanager
def case(monkeypatch, tmp_path):
    with Double() as double:
        monkeypatch.setattr(DataDriver.loaded("whatsapp"), "credentials_for", double.credentials)
        delivery = double.deliver("hello from whatsapp", sender=WA_ID)
        yield {
            "config": double.config,
            "fields": double.fields,
            "sign": double.sign,
            "push": json.loads(delivery["body"]),
            "handshake": double.handshake(),
            "min_items": 1,
            "send": {"to": WA_ID, "text": "matrix send"},
            "double": double,
        }
