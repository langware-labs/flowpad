"""Terminal tab backend contract (post Tab-entity cutover).

The strip lists terminals from the `Tab` entity (frontend query); the backend
keeps only `tabs/close` (batched PTY/worker teardown). Membership flags
(`tabbed`, the AP `visible` alias) are deleted — membership IS a `Tab` row
(see tests/unit/test_tab_entity.py).

Entity-level direct calls (no HTTP).
"""
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import BackgroundTasks

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.shell import Shell
from flow_sdk.builtin.tab import Tab, tab_id_for


def _no_reap():
    return patch.object(AgenticProcess, "reap_if_orphaned", new=AsyncMock(return_value=False))


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_last_active_at_iso_tolerant_epoch_ms():
    from datetime import datetime

    iso = "2026-06-11T10:00:00+00:00"
    s = Shell(id=str(uuid.uuid4()), status="running", last_active_at=iso)
    assert isinstance(s.last_active_at, int)
    assert s.last_active_at == int(datetime.fromisoformat(iso).timestamp() * 1000)
    s2 = Shell(id=str(uuid.uuid4()), status="running", last_active_at=1781085600001)
    assert s2.last_active_at == 1781085600001


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_agentic_process_owns_tab_order_across_reload():
    ap = AgenticProcess(id=str(uuid.uuid4()), tab_order=5)
    await ap.save()
    reloaded = await AgenticProcess.get_by_id(ap.id)
    assert reloaded.tab_order == 5
    assert "_prev_tab_order" not in (reloaded.context_data or {})
