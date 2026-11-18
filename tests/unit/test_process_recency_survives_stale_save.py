"""An opened chat stays opened through a turn's own save.

QC 2026-11-16 (ai-course stress rig): every "open the agent" click started a NEW chat — 104 of them,
13 live workers. ``Agent.openChat`` reopens ``lastChat``, which only counts a chat whose
``last_active_at`` is stamped; ``activate`` stamped it, then the turn's end
(``ClaudeDriver._after_turn`` → ``_fill_resolved_model_slug`` → ``process.save()``) saved the copy
it loaded BEFORE the chat was opened, and the whole-row write put ``last_active_at`` back to None.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

pytestmark = pytest.mark.asyncio


async def test_a_stale_save_keeps_the_open_stamp():
    process = AgenticProcess(name="chat")
    await process.save()
    stale = process.model_copy(deep=True)  # the turn's copy, loaded before the chat was opened

    stamped, did_stamp = await process._db.stamp_last_active_at(process.id, 1_794_843_905_767)
    assert did_stamp and stamped.last_active_at == 1_794_843_905_767

    stale.resolved_model_slug = "claude-opus-5-5"  # what the turn's end writes
    await stale.save()

    kept = await AgenticProcess.get_by_id(process.id)
    assert kept.resolved_model_slug == "claude-opus-5-5"
    assert kept.last_active_at == 1_794_843_905_767
