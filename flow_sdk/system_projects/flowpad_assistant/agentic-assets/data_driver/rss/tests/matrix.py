"""The ``rss`` source's case in the data source matrix: a loopback feed whose entries are dated now."""
from __future__ import annotations

from contextlib import contextmanager

from flow_sdk.ingest.testing import fresh_timestamps, local_http_server

from .test_rss_source import fixture_bytes


@contextmanager
def case(monkeypatch, tmp_path):
    body = fresh_timestamps(fixture_bytes("atom.xml"))

    def respond(_path, _headers):
        return 200, body, {"Content-Type": "application/xml"}

    with local_http_server(respond) as base:
        yield {"config": {"feed_url": f"{base}/atom"}, "min_items": 3}
