"""The ``agentmail`` source's case in the data source matrix: an inbox over a loopback AgentMail API."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone

from flow_sdk.ingest.testing import local_http_server

from .test_agentmail_source import INBOX, MSG, _AgentMail


@contextmanager
def case(monkeypatch, tmp_path):
    monkeypatch.setattr("flow_sdk.cli.auth.secrets.read_secret", lambda name: "am_test")  # the key is a machine secret, never config
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    fake = _AgentMail([{**MSG, "timestamp": now}])
    with local_http_server(fake) as base:
        yield {
            "config": {"inbox": INBOX, "base_url": base},
            "fields": {"account_key": INBOX},
            "min_items": 1,
            "send": {"to": "someone@example.com", "text": "matrix send", "subject": "Matrix"},
        }
