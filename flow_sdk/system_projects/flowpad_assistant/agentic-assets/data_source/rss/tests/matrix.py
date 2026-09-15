"""The ``rss`` source's case in the data source matrix: a loopback feed whose entries are dated now."""
from __future__ import annotations

import re
from contextlib import contextmanager
from datetime import datetime, timezone

from flow_sdk.ingest.testing import local_http_server

from .test_rss_source import fixture_bytes


@contextmanager
def case(monkeypatch, tmp_path):
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ").encode()
    body = re.sub(rb"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", stamp, fixture_bytes("atom.xml"))

    def respond(_path, _headers):
        return 200, body, {"Content-Type": "application/xml"}

    with local_http_server(respond) as base:
        yield {"config": {"feed_urls": [f"{base}/atom"]}, "min_items": 3}
