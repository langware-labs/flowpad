"""The ``waha`` source's case in the data source matrix: inbound arrives as a signed WAHA delivery,
outbound goes to a loopback WAHA. The session is this run's own, so a delivery can only match the
row the matrix made."""
from __future__ import annotations

import json
import time
import uuid
from contextlib import contextmanager

from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources.credentials import AuthShape, Credentials

from . import test_waha_source as t


@contextmanager
def case(monkeypatch, tmp_path):
    session = f"matrix{uuid.uuid4().hex[:12]}"

    async def credential(_row):  # the waha credential, never config
        return Credentials(shape=AuthShape.SECRETS, values={k: SecretStr(v) for k, v in t.SECRETS.items()})

    monkeypatch.setattr(DataDriver.loaded("waha"), "credentials_for", credential)
    monkeypatch.setattr(t, "SESSION", session)
    with local_http_server(t._Waha()) as base:
        yield {
            "config": {**t._config(base), "session": session},
            "push": t._delivery(t._message("true_x_MATRIX1", "hello from waha", timestamp=int(time.time())), session=session),
            "sign": lambda raw: {"X-Webhook-Hmac": t.sign(raw)},
            "min_items": 1,
            "send": {"to": t.PHONE, "text": "matrix send"},
        }


WEBHOOK_PATH = "/api/v1/data_source/webhook/waha"


class Double:
    """waha as a test double: a loopback WAHA whose session is this run's own, a signed webhook
    delivery you can inject, and the ``sendText`` calls it saw.

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
        self.config = {**t._config(self._server.__enter__()), "session": self.session}
        return self

    def __exit__(self, *exc):
        if self._server is not None:
            self._server.__exit__(*exc)
            self._server = None

    async def credentials(self, _row) -> Credentials:
        return Credentials(shape=AuthShape.SECRETS, values={k: SecretStr(v) for k, v in self.secrets.items()})

    def pair(self) -> None:
        """The phone scans the QR that verify left the session waiting on: the session is WORKING."""
        self.waha.status = "WORKING"

    def deliver(self, text: str, *, sender: str, thread=None) -> dict:
        """A message from ``sender`` arriving now; the caller POSTs ``body`` with ``headers`` to ``path``."""
        self._delivered += 1
        chat = f"{sender}@c.us" if str(sender).isdigit() else str(sender)
        message_id = f"false_{chat}_IN{self._delivered}{uuid.uuid4().hex[:6]}"
        payload = t._delivery(t._message(message_id, text, chat=chat, timestamp=int(time.time())), session=self.session)
        raw = json.dumps(payload).encode()
        return {"external_id": message_id, "thread": chat, "path": WEBHOOK_PATH, "body": raw,
                "headers": {"X-Webhook-Hmac": t.sign(raw)}}

    def sent(self) -> list[dict]:
        """Every ``sendText`` WAHA accepted, oldest first."""
        return [
            {"to": str(body.get("chatId") or "").split("@")[0], "text": body.get("text"), "thread": body.get("chatId"),
             "external_id": f"OUT{n}"}
            for n, (method, path, body) in enumerate(self.waha.calls, start=1)
            if method == "POST" and path == "/api/sendText"
        ]
