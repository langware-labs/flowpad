"""RCA capture (2026-09-27): ComputeNode._index_system_assets() loses the shared
"index" activity race to another caller (in production: `_auto_index_project`,
fired by the user's first-opened project) and silently returns — no shipped
wizard/compute_op/trigger gets indexed for the rest of that process's life.

Proven this session: instrumenting the real method showed 0 indexer calls
with the slot held vs 1 with it free. This test drives the SAME real lock
primitive (`_start_activity`/`_complete_activity`) and the SAME real method
`ComputeNode._index_system_assets()` — the exact call `bootstrap.index_system_content()`
makes at every server startup — and checks the REAL, product-observable
symptom: a shipped wizard (`llm-setup`) is missing from the DB, which is what
made first-run setup answer 404 on a real machine (its wizard was not in the DB).
"""

import asyncio

import pytest

from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.wizard import Wizard

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.mark.asyncio
async def test_a_lost_index_race_still_indexes_the_shipped_wizards():
    node = await ComputeNode.get_local()
    assert node is not None, "precondition: the local compute node must exist"

    # Session-scoped DB: an earlier test may have left a real row here. Clear it
    # so the assertion below reflects THIS call, not leftover state.
    stale = await Wizard.get_one({"name": "llm-setup"})
    if stale is not None:
        await stale.delete()

    # The real rival: `_auto_index_project` (fired by "my_first_project" being
    # auto-opened on first launch) claims this SAME slot through this SAME
    # primitive, and releases it once ITS OWN work is done — never held for
    # the test's own lifetime, or this deadlocks against a fix that queues.
    node._start_activity("index", timeout_seconds=600)
    task = asyncio.create_task(node._index_system_assets())
    await asyncio.sleep(0.05)  # let it actually reach the contended claim
    node._complete_activity("index")
    await task

    wizard = await Wizard.get_one({"name": "llm-setup"})
    assert wizard is not None, (
        "a lost 'index' activity race must not leave shipped wizards unindexed — "
        "ComputeNode._index_system_assets() silently returned on RuntimeError "
        "instead of queuing for the slot"
    )
