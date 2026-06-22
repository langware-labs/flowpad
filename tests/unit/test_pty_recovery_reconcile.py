"""Unit tests for ``reconcile_orphaned_workers`` (startup orphan sweep).

Regression for the post-restart phantom-agents bug: after a backend restart the
previous process's child workers die (SIGHUP), but a *headless* (``visible=false``)
AgenticProcess keeps ``status=running`` on disk. Nothing in PTY recovery reconciles
it (recovery only respawns *visible* PTYs), so it lingers as a phantom "Background"
agent in the footer chip — whose count keys on ``status ∈ {RUNNING, STARTING}``.

``reconcile_orphaned_workers`` runs at startup and stamps those orphaned headless
workers to ``STOPPED``. Real entities, real DB (session SQLite fixture + per-test
records root from tests/conftest.py) — no mocks. The "dead worker" state is simply a
RUNNING/visible=false row with no live shell, which is exactly what the empty
in-memory PTY registry leaves behind after a restart.
"""

import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.server.pty_recovery import reconcile_orphaned_workers


def _proc(**kwargs) -> AgenticProcess:
    return AgenticProcess(id=str(uuid.uuid4()), **kwargs)


@pytest.mark.asyncio
async def test_reconcile_stops_orphaned_headless_running():
    """A RUNNING headless worker is stamped STOPPED (fails pre-fix: stays RUNNING)."""
    proc = _proc(status=ProcessStatus.RUNNING.value, visible=False)
    await proc.save()

    await reconcile_orphaned_workers()

    reloaded = await AgenticProcess.get_by_id(proc.id)
    assert reloaded is not None
    assert reloaded.status == ProcessStatus.STOPPED.value


@pytest.mark.asyncio
async def test_reconcile_stops_orphaned_headless_starting():
    """A STARTING headless worker is also a dead orphan after restart → STOPPED."""
    proc = _proc(status=ProcessStatus.STARTING.value, visible=False)
    await proc.save()

    await reconcile_orphaned_workers()

    reloaded = await AgenticProcess.get_by_id(proc.id)
    assert reloaded is not None
    assert reloaded.status == ProcessStatus.STOPPED.value


@pytest.mark.asyncio
async def test_reconcile_leaves_visible_pty_running():
    """Visible PTYs belong to run_pty_recovery (respawn) — the sweep must not touch them."""
    proc = _proc(status=ProcessStatus.RUNNING.value, visible=True)
    await proc.save()

    await reconcile_orphaned_workers()

    reloaded = await AgenticProcess.get_by_id(proc.id)
    assert reloaded is not None
    assert reloaded.status == ProcessStatus.RUNNING.value


@pytest.mark.asyncio
async def test_reconcile_leaves_already_terminal_untouched():
    """An already-STOPPED headless row is left exactly as-is (idempotent)."""
    proc = _proc(status=ProcessStatus.STOPPED.value, visible=False)
    await proc.save()

    await reconcile_orphaned_workers()

    reloaded = await AgenticProcess.get_by_id(proc.id)
    assert reloaded is not None
    assert reloaded.status == ProcessStatus.STOPPED.value
