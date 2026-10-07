"""The ``flow_slack`` source's case in the data source matrix: the hub a transport double, the account linked.
Its messages are handed to it by the hub's ``@slack`` webhook, never synced — the driver tests pin those."""

from __future__ import annotations

from contextlib import contextmanager

from .test_flow_slack_source import ME, FlowSlackSource, _Hub


@contextmanager
def case(monkeypatch, tmp_path):
    fake = _Hub()
    fake.links["L1"] = {"id": "L1", "status": "connected", "code": "", "sender": ME}
    monkeypatch.setattr(FlowSlackSource, "build", classmethod(lambda cls, binding: cls(binding, hub=fake)))
    yield {"config": {"link_id": "L1", "sender": ME}, "min_items": 0, "send": {"to": ME, "text": "matrix send"}}
