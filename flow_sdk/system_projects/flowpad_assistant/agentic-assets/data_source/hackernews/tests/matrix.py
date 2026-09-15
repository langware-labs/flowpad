"""The ``hackernews`` source's case in the data source matrix: the updates feed over a loopback API."""
from __future__ import annotations

from contextlib import contextmanager

from flow_sdk.ingest.testing import local_http_server

from .test_hackernews_source import _STATE, _respond


@contextmanager
def case(monkeypatch, tmp_path):
    _STATE.update(updates=[101, 102, 103, 104], fail=False)
    with local_http_server(_respond) as base:
        yield {"config": {"base_url": base}, "fields": {"window_days": 36500}, "min_items": 2}
