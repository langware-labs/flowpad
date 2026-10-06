"""The ``flow_whatsapp`` source's case in the data source matrix: the hub handed to the source as a
transport double and the person's phone already linked. Its messages are handed to it by the hub's
``@whatsapp`` webhook (``/api/v1/data_source/<id>/webhook``), never synced — the driver tests pin those."""
from __future__ import annotations

from contextlib import contextmanager

from .test_flow_whatsapp_source import PHONE, FlowWhatsAppSource, _Hub


@contextmanager
def case(monkeypatch, tmp_path):
    fake = _Hub()
    fake.links["L1"] = {"id": "L1", "status": "connected", "code": "AB2CD3", "wa_id": PHONE}
    monkeypatch.setattr(FlowWhatsAppSource, "build", classmethod(lambda cls, binding: cls(binding, hub=fake)))
    yield {
        "config": {"link_id": "L1", "wa_id": PHONE},
        "min_items": 0,
        "send": {"to": PHONE, "text": "matrix send"},
    }
