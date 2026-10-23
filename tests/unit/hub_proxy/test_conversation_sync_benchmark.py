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
import pytest_asyncio

from tests.unit.hub_proxy.test_failure_modes_echo import CONVERSATIONS, _conversation_list, _hub_conversations

pytestmark = [pytest.mark.long]

ROWS = 2_400
# End to end, every row is also written locally — ~2 ms each, RECONCILE_BATCH rows per writer transaction
# (it was ~8 ms each, one transaction per row, and only 1,000 fit inside the 30 s test cap).
E2E_ROWS = 2_400
PAGE_BUDGET_S = 10.0


@pytest_asyncio.fixture
async def hub_with_conversations(echo_hub):
    echo_hub.scripted[("GET", "/api/v1/graph/invitation/pending")] = []
    echo_hub.paged[CONVERSATIONS] = _hub_conversations(ROWS)
    ids = [row["id"] for row in echo_hub.paged[CONVERSATIONS]]
    yield echo_hub
    # The session DB is shared: 2,400 remote rows left behind are pruned one by one by the next
    # conversation-list test (which then runs out of time). Remove them in one statement.
    from sqlalchemy import bindparam, text

    from flow_sdk.builtin.conversation import Conversation

    async with Conversation._db.session_factory() as session:
        await session.execute(text("DELETE FROM entities WHERE id IN :ids").bindparams(bindparam("ids", expanding=True)),
                              {"ids": ids})  # fmt: skip
        await session.commit()


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
    from flow_sdk.app.actions import flow_message_action
    from flow_sdk.builtin.conversation import Conversation

    echo_hub = hub_with_conversations
    echo_hub.paged[CONVERSATIONS] = echo_hub.paged[CONVERSATIONS][:E2E_ROWS]
    started = time.monotonic()
    data = await _conversation_list()
    cold_s = time.monotonic() - started
    assert data["hub_reachable"]
    pages = [r for r in echo_hub.received if r.raw_path == CONVERSATIONS]
    assert len(pages) == -(-E2E_ROWS // 200)
    assert max(echo_hub.paged_seconds) < PAGE_BUDGET_S / 4
    # The caller gets its answer inside the foreground budget; the rest lands right after.
    assert cold_s < flow_message_action.FOREGROUND_RECONCILE_S + 3, f"first sync answered after {cold_s:.2f}s"
    started = time.monotonic()
    if flow_message_action._deferred_reconcile is not None:
        await flow_message_action._deferred_reconcile
    background_s = time.monotonic() - started
    # Measured ~3.4 s + ~1.3 s for 2,400 rows (one transaction per row took ~20 s in all).
    assert cold_s + background_s < 12, f"the first sync took {cold_s:.2f}s + {background_s:.2f}s in the background"
    hub_ids = {row["id"] for row in echo_hub.paged[CONVERSATIONS]}
    assert hub_ids <= {c.id for c in await Conversation.get_all({})}, "the walk did not bring every row in"
    started = time.monotonic()
    await _conversation_list()
    warm_s = time.monotonic() - started
    print(
        f"\n[benchmark] conversation-list, {E2E_ROWS} hub conversations: first answer {cold_s:.2f}s "
        f"(+{background_s:.2f}s in the background), next sync {warm_s:.2f}s"
    )
    assert warm_s < 5, f"an unchanged list took {warm_s:.2f}s to sync"
