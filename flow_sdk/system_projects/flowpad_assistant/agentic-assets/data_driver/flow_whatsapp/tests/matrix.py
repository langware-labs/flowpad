"""The ``flow_whatsapp`` source's case in the data source matrix: the hub handed to the source as a
transport double, the person's phone already linked, and one message from them waiting on the hub."""
from __future__ import annotations

import time
from contextlib import contextmanager

from .test_flow_whatsapp_source import PHONE, FlowWhatsAppSource, _Hub


@contextmanager
def case(monkeypatch, tmp_path):
    fake = _Hub()
    fake.links["L1"] = {"id": "L1", "status": "connected", "code": "AB2CD3", "wa_id": PHONE}
    fake.stored.append({"wamid": "wamid.IN1", "wa_id": PHONE, "direction": "in", "text": "hello Flow", "profile_name": "Dana", "at": time.time()})
    monkeypatch.setattr(FlowWhatsAppSource, "build", classmethod(lambda cls, binding: cls(binding, hub=fake)))
    yield {
        "config": {"link_id": "L1", "wa_id": PHONE},
        "min_items": 1,
        "send": {"to": PHONE, "text": "matrix send"},
    }
