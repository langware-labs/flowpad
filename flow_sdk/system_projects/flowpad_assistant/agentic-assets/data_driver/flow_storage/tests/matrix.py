"""The ``flow_storage`` source's case in the data source matrix: a hub data store of three files,
the hub stood in for by the in-memory ``FakeHub``."""
from __future__ import annotations

import sys
from contextlib import contextmanager

from flow_sdk.builtin.data_driver import DataDriver

from .test_flow_storage_source import FakeHub


@contextmanager
def case(monkeypatch, tmp_path):
    hub = FakeHub()
    hub.stores["store-1"] = {path: (body, n) for n, (path, body) in enumerate(
        (("a.md", b"# a\n"), ("b/c.md", b"# c\n"), ("d.md", b"# d\n")), start=1)}
    hub.tick = 3
    source = sys.modules[DataDriver.loaded("flow_storage").cls.__module__]
    monkeypatch.setattr(source, "hub_get_or_raise", hub.get)
    monkeypatch.setattr(source, "hub_post", hub.post)
    yield {"config": {"store_id": "store-1"}, "fields": {"reflect": "copy"}}
