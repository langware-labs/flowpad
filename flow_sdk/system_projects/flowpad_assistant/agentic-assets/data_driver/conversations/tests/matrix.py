"""The ``conversations`` source's case in the data source matrix: a hub handed to the source as a
transport double, signed in as an agent, one conversation with one message."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone

from .test_conversations_source import CONVERSATION, MSG, ROW, ConversationsSource, _Hub


@contextmanager
def case(monkeypatch, tmp_path):
    now = datetime.now(timezone.utc).isoformat()
    fake = _Hub([{**ROW, "updated_date": now}], {CONVERSATION: [{**MSG, "created_date": now, "updated_date": now}]})
    monkeypatch.setattr(ConversationsSource, "build", classmethod(lambda cls, binding: cls(binding, hub=fake)))
    yield {
        "config": {},
        "min_items": 1,
        "send": {"to": CONVERSATION, "text": "matrix send"},
    }
