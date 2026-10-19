"""The ``agent`` source's case in the data source matrix: a harness worker double. The worker records
its own items through the ingest route, so a sync writes none here; a send is the worker's."""
from __future__ import annotations

from contextlib import contextmanager

from .test_agent_source import AgentSource, _Worker


@contextmanager
def case(monkeypatch, tmp_path):
    fake = _Worker()
    monkeypatch.setattr(AgentSource, "build", classmethod(lambda cls, binding: cls(binding, worker=fake)))
    yield {
        "config": {"connector": "gmail", "harness": "claude"},
        "min_items": 0,
        "send": {"to": "someone@example.com", "text": "matrix send", "thread_key": "t-1"},
    }
