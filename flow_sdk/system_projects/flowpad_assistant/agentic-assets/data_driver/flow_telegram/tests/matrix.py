"""The ``flow_telegram`` source's case in the data source matrix: the hub a transport double, the account linked.
Its messages are handed to it by the hub's ``@telegram`` webhook, never synced — the driver tests pin those."""

from __future__ import annotations

from contextlib import contextmanager

from .test_flow_telegram_source import ME, FlowTelegramSource, _Hub


@contextmanager
def case(monkeypatch, tmp_path):
    fake = _Hub()
    fake.claims["C1"] = {"id": "C1", "status": "active", "code": "", "claim": {"kind": "user", "key": ME}, "sender": ME}
    monkeypatch.setattr(FlowTelegramSource, "build", classmethod(lambda cls, binding: cls(binding, hub=fake)))
    yield {"config": {"claim_id": "C1", "sender": ME}, "min_items": 0, "send": {"to": ME, "text": "matrix send"}}
