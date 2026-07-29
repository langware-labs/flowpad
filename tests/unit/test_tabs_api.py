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
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.shell import Shell
from flow_sdk.builtin.tab import (
    Tab,
    _load_remote_targets,
    _populate_tab_target_remote,
    _serialize_row,
    tab_id_for,
)


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


@pytest.mark.asyncio
async def test_tab_target_remote_batches_once_per_type():
    cloud = Docs(
        id=str(uuid.uuid4()),
        name=f"cloud_doc_{uuid.uuid4().hex[:6]}",
        remote=True,
    )
    local = Docs(
        id=str(uuid.uuid4()),
        name=f"local_doc_{uuid.uuid4().hex[:6]}",
        remote=False,
    )
    await cloud.save()
    await local.save()
    tabs = [
        Tab(id=str(uuid.uuid4()), target_type="markdown", target_id=cloud.id),
        Tab(id=str(uuid.uuid4()), target_type="markdown", target_id=local.id),
        Tab(id=str(uuid.uuid4()), target_type="markdown", target_id=str(uuid.uuid4())),
    ]

    try:
        with (
            patch.object(Docs, "get_all", new=AsyncMock(wraps=Docs.get_all)) as get_all,
            patch.object(
                Docs,
                "get_one",
                new=AsyncMock(side_effect=AssertionError("get_one is not allowed")),
            ),
        ):
            targets = await _load_remote_targets(tabs)
        _populate_tab_target_remote(tabs, targets)

        assert get_all.await_count == 1
        assert [tab.target_remote for tab in tabs] == [True, False, False]
        assert [_serialize_row(tab)["target_remote"] for tab in tabs] == [
            True,
            False,
            False,
        ]
    finally:
        await cloud.delete()
        await local.delete()


@pytest.mark.asyncio
async def test_tab_target_remote_is_not_persisted():
    tab = Tab(
        id=str(uuid.uuid4()),
        pointer=f"conversation|{uuid.uuid4()}",
        target_remote=True,
    )
    await tab.save()
    try:
        reloaded = await Tab.get_by_id(tab.id)
        assert reloaded is not None
        assert reloaded.target_remote is False
    finally:
        await tab.delete()
