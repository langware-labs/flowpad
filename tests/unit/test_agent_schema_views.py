"""The agent's screen catalogue — `flow schema views` / `/api/v1/agent/schema/views`.

This payload had NO test, and it is the only machine-readable list of destinations
an agent has. See `docs/display-capabilities.md` for what that cost.
"""

import asyncio

from flow_sdk.core.dock_address import VIEW_META, ViewType
from flow_sdk.server.routes.agent_records import list_schema_views


def _views() -> list[dict]:
    payload = asyncio.run(list_schema_views())
    assert payload["ok"] is True
    return payload["views"]


def test_lists_exactly_the_addressable_views():
    published = {row["view_type"] for row in _views()}
    assert published == {view.value for view, meta in VIEW_META.items() if meta.addressable}


def test_every_row_carries_the_vocabulary_an_agent_needs():
    for row in _views():
        assert row["label"], f"{row['view_type']} has no name to match on"
        assert isinstance(row["aliases"], list)
        assert row["page"], row["view_type"]
        assert row["pointer"] in {"none", "optional", "required"}


def test_the_connections_screen_is_findable_by_that_word():
    """The literal regression. `credentials` is the slug; nobody says "credentials"."""
    row = next(r for r in _views() if r["view_type"] == ViewType.CREDENTIALS.value)
    assert "connections" in row["aliases"]
