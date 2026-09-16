"""The ``whatsapp`` source's case in the data source matrix: inbound arrives as a webhook delivery (the
Cloud API lists nothing), outbound goes to a loopback Graph. The business number is this run's own, so
a delivery can only match the row the matrix made."""
from __future__ import annotations

import time
import uuid
from contextlib import contextmanager

from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources.credentials import AuthShape, Credentials

from .test_whatsapp_source import APP_SECRET, WA_ID, _Graph, _text, _webhook, sign, wa_source


@contextmanager
def case(monkeypatch, tmp_path):
    phone_number_id = f"matrix{uuid.uuid4().hex[:12]}"

    async def credential(_row):  # the whatsapp credential, never config
        return Credentials(shape=AuthShape.SECRETS, values={"access_token": SecretStr("EAAG-test"), "app_secret": SecretStr(APP_SECRET)})

    monkeypatch.setattr(DataDriver.loaded("whatsapp"), "credentials_for", credential)
    with local_http_server(_Graph()) as base:
        monkeypatch.setattr(wa_source, "GRAPH_API_BASE", base)
        yield {
            "config": {
                "phone_number_id": phone_number_id,
                "verify_token": "matrix-token",
            },
            "sign": lambda raw: {"X-Hub-Signature-256": sign(raw)},
            "push": _webhook(_text("wamid.MATRIX1", "hello from whatsapp", ts=str(int(time.time()))), phone_number_id=phone_number_id),
            "handshake": {"hub.mode": "subscribe", "hub.verify_token": "matrix-token", "hub.challenge": "42"},
            "min_items": 1,
            "send": {"to": WA_ID, "text": "matrix send"},
        }
