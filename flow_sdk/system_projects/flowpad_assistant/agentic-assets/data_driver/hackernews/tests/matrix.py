"""The ``hackernews`` source's case in the data source matrix: the updates feed over a loopback API,
its stories posted a minute ago."""
from __future__ import annotations

import time
from contextlib import contextmanager

from flow_sdk.ingest.testing import local_http_server

from .test_hackernews_source import _STATE, ITEMS, _respond


@contextmanager
def case(monkeypatch, tmp_path):
    monkeypatch.setitem(_STATE, "updates", [101, 102, 103, 104])
    monkeypatch.setitem(_STATE, "fail", False)
    for item_id, item in list(ITEMS.items()):
        monkeypatch.setitem(ITEMS, item_id, {**item, "time": int(time.time()) - 60})
    with local_http_server(_respond) as base:
        yield {"config": {"base_url": base}, "min_items": 2}
