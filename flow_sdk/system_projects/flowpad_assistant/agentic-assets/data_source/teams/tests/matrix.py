"""The ``teams`` source's case in the data source matrix: a stateful Microsoft Graph over a loopback
socket, read and posted to with a doubled connector token, its roots minutes old."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from flow_sdk.ingest.sources import source_type
from flow_sdk.ingest.testing import local_http_server

from .test_teams_source import SEGMENT, _FakeGraph, _message, _token, teams_source


@contextmanager
def case(monkeypatch, tmp_path):
    monkeypatch.setattr(source_type("teams"), "credentials_for", _token("graph-test-token"))
    now = datetime.now(timezone.utc)
    fake = _FakeGraph()
    fake.roots = [_message(str(n), f"root {n}", created=(now - timedelta(minutes=10 - n)).strftime("%Y-%m-%dT%H:%M:%SZ")) for n in (1, 2, 3)]
    with local_http_server(fake) as base:
        monkeypatch.setattr(teams_source, "GRAPH_API_BASE", base)
        yield {
            "config": {"channels": [SEGMENT]},
            "min_items": 3,
            "send": {"to": SEGMENT, "text": "matrix send"},
        }
