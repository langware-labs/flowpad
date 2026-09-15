"""The ``slack`` source's case in the data source matrix: a stateful Slack over a loopback socket, read
and posted to with a doubled connector token."""
from __future__ import annotations

from contextlib import contextmanager

from flow_sdk.ingest.sources import source_type
from flow_sdk.ingest.testing import local_http_server

from .test_slack_source import _credentials, _FakeSlack, slack_source

#: A channel id the manifest's own pattern accepts.
CHANNEL = "C0MATRIX1"


@contextmanager
def case(monkeypatch, tmp_path):
    monkeypatch.setattr(source_type("slack"), "credentials_for", _credentials("xoxb-test"))
    fake = _FakeSlack()
    fake.channels = {CHANNEL: fake.channels.pop("C1")}
    with local_http_server(fake) as base:
        monkeypatch.setattr(slack_source, "SLACK_API_BASE", base)
        yield {
            "config": {"channels": [CHANNEL]},
            "fields": {"account_key": "T1", "window_days": 36500},
            "min_items": 3,
            "send": {"to": CHANNEL, "text": "matrix send"},
        }
