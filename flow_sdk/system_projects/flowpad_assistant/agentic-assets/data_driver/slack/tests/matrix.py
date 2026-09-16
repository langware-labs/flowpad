"""The ``slack`` source's case in the data source matrix: a stateful Slack over a loopback socket, read
and posted to with a doubled connector token, its history minutes old."""
from __future__ import annotations

import time
from contextlib import contextmanager

from flow_sdk.ingest.driver_types import driver_type
from flow_sdk.ingest.testing import local_http_server

from .test_slack_source import _credentials, _FakeSlack, _message, slack_source

#: A channel id the manifest's own pattern accepts.
CHANNEL = "C0MATRIX1"


@contextmanager
def case(monkeypatch, tmp_path):
    monkeypatch.setattr(driver_type("slack"), "credentials_for", _credentials("xoxb-test"))
    now = int(time.time())
    root = f"{now - 300}.000100"
    fake = _FakeSlack()
    fake.clock = now
    fake.channels = {CHANNEL: [_message(root, "root"), _message(f"{now - 200}.000200", "in thread", thread_ts=root), _message(f"{now - 100}.000300", "later")]}
    with local_http_server(fake) as base:
        monkeypatch.setattr(slack_source, "SLACK_API_BASE", base)
        yield {
            "config": {"channels": [CHANNEL]},
            "fields": {"account_key": "T1"},
            "min_items": 3,
            "send": {"to": CHANNEL, "text": "matrix send"},
        }
