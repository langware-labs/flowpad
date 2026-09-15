"""The ``teams`` source's case in the data source matrix: a stateful Microsoft Graph over a loopback
socket, read and posted to with a doubled connector token."""
from __future__ import annotations

from contextlib import contextmanager

from flow_sdk.ingest.sources import source_type
from flow_sdk.ingest.testing import local_http_server

from .test_teams_source import SEGMENT, _FakeGraph, _token, teams_source


@contextmanager
def case(monkeypatch, tmp_path):
    monkeypatch.setattr(source_type("teams"), "credentials_for", _token("graph-test-token"))
    with local_http_server(_FakeGraph()) as base:
        monkeypatch.setattr(teams_source, "GRAPH_API_BASE", base)
        yield {
            "config": {"channels": [SEGMENT]},
            "fields": {"window_days": 36500},
            "min_items": 3,
            "send": {"to": SEGMENT, "text": "matrix send"},
        }
