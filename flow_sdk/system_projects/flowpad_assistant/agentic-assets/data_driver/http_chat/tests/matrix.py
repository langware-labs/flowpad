"""The ``http_chat`` source's case in the data source matrix: a deployment's chat channel.

Nothing is fetched — its messages are the requests the deployment's ``chat`` endpoint pushes in
(``events_from_request``; ``tests/api/test_http_chat_channel.py`` drives that end to end) — so a sync
ingests none. A send is said to a caller, and starts a conversation of theirs.
"""
from __future__ import annotations

from contextlib import contextmanager

from flow_sdk.api.api_types.identifier import mint_uuid


@contextmanager
def case(monkeypatch, tmp_path):
    yield {
        "config": {"deployment_id": str(mint_uuid())},
        "min_items": 0,
        "send": {"to": "local", "text": "matrix send"},
    }
