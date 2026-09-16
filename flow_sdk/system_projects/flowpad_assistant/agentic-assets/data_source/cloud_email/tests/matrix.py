"""The ``cloud_email`` source's case in the data source matrix: a hub mailbox handed to the source as a
transport double."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone

from .test_cloud_email_source import ADDRESS, AGENT_ID, LIST_ITEM, CloudEmailSource, _Mailbox


@contextmanager
def case(monkeypatch, tmp_path):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    fake = _Mailbox([{**LIST_ITEM, "timestamp": now}])
    monkeypatch.setattr(CloudEmailSource, "build", classmethod(lambda cls, binding: cls(binding, mailbox=fake)))
    yield {
        "config": {"agent_id": AGENT_ID, "address": ADDRESS},
        "fields": {"account_key": ADDRESS},
        "min_items": 1,
        "send": {"to": "someone@example.com", "text": "matrix send", "subject": "Matrix"},
    }
