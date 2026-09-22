"""The ``whatsapp`` source's case in the data source matrix, and the ``Double`` behind it: inbound
arrives as a webhook delivery (the Cloud API lists nothing), outbound goes to a loopback Graph. The
business number is the Double's own, so a delivery can only match the row built on its config."""
from __future__ import annotations

import json
import time
import uuid
from contextlib import contextmanager
from typing import Optional

from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources.credentials import AuthShape, Credentials

from .test_whatsapp_source import APP_SECRET, WA_ID, _Graph, _text, _webhook, sign

WEBHOOK_PATH = "/api/v1/data_source/webhook/whatsapp"


class Double:
    """whatsapp as a test double: a loopback Graph, a webhook delivery you can inject, the sends Graph saw.

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
        self.config = {"phone_number_id": self.phone_number_id, "verify_token": self.verify_token, "base_url": self._server.__enter__()}
        return self

    def __exit__(self, *exc):
        if self._server is not None:
            self._server.__exit__(*exc)
            self._server = None

    async def credentials(self, _row) -> Credentials:
        """The in-process stand-in for ``DataDriver.credentials_for``: the whatsapp credential, never config."""
        return Credentials(shape=AuthShape.SECRETS, values={k: SecretStr(v) for k, v in self.secrets.items()})

    def handshake(self) -> dict:
        """Meta's one-time subscribe query, carrying this Double's verify token."""
        return {"hub.mode": "subscribe", "hub.verify_token": self.verify_token, "hub.challenge": "42"}

    def sign(self, raw: bytes) -> dict:
        return {"X-Hub-Signature-256": sign(raw)}

    def deliver(self, text: str, *, sender: str, thread: Optional[str] = None) -> dict:
        """A message from ``sender`` arriving now. The person IS the conversation, so the thread is the
        sender whatever ``thread`` says; the caller POSTs ``body`` with ``headers`` to ``path``."""
        self._delivered += 1
        external_id = f"wamid.{self._delivered}"
        message = _text(external_id, text, ts=str(int(time.time())), **{"from": sender})
        payload = _webhook(message, contacts=[{"wa_id": sender, "profile": {"name": f"Person {sender}"}}], phone_number_id=self.phone_number_id)
        raw = json.dumps(payload).encode()
        return {"external_id": external_id, "thread": sender, "path": WEBHOOK_PATH, "body": raw, "headers": self.sign(raw)}

    def sent(self) -> list[dict]:
        """Every ``/messages`` POST the Graph double accepted, oldest first."""
        out, n = [], 0
        for path, body in zip(self.graph.requests, self.graph.bodies):
            if not (path.split("?")[0].endswith("/messages") and body):
                continue
            n += 1
            sent = json.loads(body)
            out.append({"to": sent.get("to"), "text": (sent.get("text") or {}).get("body"), "thread": (sent.get("context") or {}).get("message_id"), "external_id": f"wamid.OUT{n}"})
        return out


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
