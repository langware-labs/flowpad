"""The ``whatsapp`` source's case in the data source matrix: inbound arrives as a webhook delivery (the
Cloud API lists nothing), outbound goes to a loopback Graph."""
from __future__ import annotations

import time
from contextlib import contextmanager

from flow_sdk.ingest.testing import local_http_server

from .test_whatsapp_source import PHONE_ID, WA_ID, _Graph, _text, _webhook, wa_source


@contextmanager
def case(monkeypatch, tmp_path):
    with local_http_server(_Graph()) as base:
        monkeypatch.setattr(wa_source, "GRAPH_API_BASE", base)
        yield {
            "config": {"phone_number_id": PHONE_ID, "access_token": "EAAG-test", "verify_token": "matrix-token"},
            "push": _webhook(_text("wamid.MATRIX1", "hello from whatsapp", ts=str(int(time.time())))),
            "handshake": {"hub.mode": "subscribe", "hub.verify_token": "matrix-token", "hub.challenge": "42"},
            "min_items": 1,
            "send": {"to": WA_ID, "text": "matrix send"},
        }
