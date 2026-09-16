"""The ``waha`` source's case in the data source matrix: inbound arrives as a signed WAHA delivery,
outbound goes to a loopback WAHA. The session is this run's own, so a delivery can only match the
row the matrix made."""
from __future__ import annotations

import time
import uuid
from contextlib import contextmanager

from flow_sdk.ingest.testing import local_http_server

from . import test_waha_source as t


@contextmanager
def case(monkeypatch, tmp_path):
    session = f"matrix{uuid.uuid4().hex[:12]}"
    monkeypatch.setattr(t, "SESSION", session)
    with local_http_server(t._Waha()) as base:
        yield {
            "config": {**t._config(base), "session": session},
            "push": t._delivery(t._message("true_x_MATRIX1", "hello from waha", timestamp=int(time.time())), session=session),
            "sign": lambda raw: {"X-Webhook-Hmac": t.sign(raw)},
            "min_items": 1,
            "send": {"to": t.PHONE, "text": "matrix send"},
        }
