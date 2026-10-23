"""Benchmark: the conversation-list sync walking a 2,400-row hub list page by page.

The hub pages every list (200 rows a page here), so ``handle_conversation_list`` walks 12 pages and
reconciles every row. These time it against the real echo hub and real local DB, print the numbers,
and hold the line that matters: the walk completes, and no page comes near the 10 s per-request
budget (``hub_proxy.DEFAULT_TIMEOUT``) — a page that did would cut the walk short and leave the list
unpruned.
"""

from __future__ import annotations

import time

import pytest

from tests.unit.hub_proxy.test_failure_modes_echo import CONVERSATIONS, _conversation_list, _hub_conversations

pytestmark = [pytest.mark.long]

ROWS = 2_400
PAGE_BUDGET_S = 10.0


@pytest.fixture
def hub_with_conversations(echo_hub):
    echo_hub.scripted[("GET", "/api/v1/graph/invitation/pending")] = []
    echo_hub.paged[CONVERSATIONS] = _hub_conversations(ROWS)
    return echo_hub


async def test_the_walk_over_2400_conversations_pages_well_inside_the_budget(desktop, hub_with_conversations):
    from flow_sdk.cloud_client.hub_proxy import WALK_PAGE_SIZE, HubProxy

    echo_hub = hub_with_conversations
    started = time.monotonic()
    walk = await HubProxy.walk("conversation")
    walk_s = time.monotonic() - started
    assert walk.complete and len(walk.rows) == ROWS
    assert [row["id"] for row in walk.rows] == [row["id"] for row in echo_hub.paged[CONVERSATIONS]]
    assert walk.pages == -(-ROWS // WALK_PAGE_SIZE)
    slowest = max(walk.page_seconds)
    print(
        f"\n[benchmark] walk {ROWS} conversations, {walk.pages} pages of {WALK_PAGE_SIZE}: {walk_s:.2f}s "
        f"(slowest page {slowest * 1000:.0f} ms, hub-side max {max(echo_hub.paged_seconds) * 1000:.0f} ms)"
    )
    assert slowest < PAGE_BUDGET_S / 4, f"a page took {slowest:.2f}s, near the {PAGE_BUDGET_S}s per-page timeout"


async def test_the_conversation_list_over_2400_hub_conversations_end_to_end(desktop, hub_with_conversations):
    echo_hub = hub_with_conversations
    started = time.monotonic()
    data = await _conversation_list()
    cold_s = time.monotonic() - started
    print(f"\n[benchmark] conversation-list, {ROWS} hub conversations, first sync: {cold_s:.2f}s")
    hub_ids = {row["id"] for row in echo_hub.paged[CONVERSATIONS]}
    assert data["hub_reachable"]
    assert hub_ids <= {c["id"] for c in data["conversations"]}, "the walk did not bring every page in"
    pages = [r for r in echo_hub.received if r.raw_path == CONVERSATIONS]
    assert len(pages) == 12
    assert max(echo_hub.paged_seconds) < PAGE_BUDGET_S / 4
