"""The ``flow_storage`` source's case in the data source matrix: a hub data store of three files,
the hub stood in for by the in-memory ``FakeHub``."""
from __future__ import annotations

from contextlib import contextmanager

from flow_sdk.cloud_client.hub_proxy import HubProxy

from .test_flow_storage_source import FakeHub


@contextmanager
def case(monkeypatch, tmp_path):
    hub = FakeHub()
    hub.stores["store-1"] = {path: (body, n) for n, (path, body) in enumerate(
        (("a.md", b"# a\n"), ("b/c.md", b"# c\n"), ("d.md", b"# d\n")), start=1)}
    hub.tick = 3
    monkeypatch.setattr(HubProxy, "get_or_raise", staticmethod(hub.get))
    monkeypatch.setattr(HubProxy, "post", staticmethod(hub.post))
    yield {"config": {"store_id": "store-1"}, "fields": {"reflect": "copy"}}
