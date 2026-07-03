"""Unit tests for the recovery split — ``reconcile_orphaned_workers`` (startup
orphan sweep) vs ``run_pty_recovery`` (on-demand PTY respawn).

Regression for the post-restart phantom-agents bug: after a backend restart the
previous process's child workers die (SIGHUP), but a *headless* (``pty_mode=false``)
AgenticProcess keeps ``status=running`` on disk. Nothing in PTY recovery reconciles
it (recovery only respawns *PTY-transport* workers), so it lingers as a phantom
"Background" agent in the footer chip — whose count keys on ``status ∈ {RUNNING,
STARTING}``.

The split MUST key on the transport (``pty_mode``), NOT tab visibility (``visible``):
a hidden live PTY (``visible=false`` but ``pty_mode=true``) is a resumable PTY worker
owned by ``run_pty_recovery``. Keying the sweep on ``visible`` (the pre-fix bug)
stamps that recoverable session STOPPED and skips its respawn.

``reconcile_orphaned_workers`` runs at startup and stamps orphaned *headless*
workers to ``STOPPED``. Real entities, real DB (session SQLite fixture + per-test
records root from tests/conftest.py). The "dead worker" state is simply a
RUNNING row with no live shell, which is exactly what the empty in-memory PTY
registry leaves behind after a restart.
"""

import uuid

import pytest

from flow_sdk.app.actions.watch_registry import add_watch, remove_watch
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.server.pty_recovery import reconcile_orphaned_workers, run_pty_recovery


def _proc(**kwargs) -> AgenticProcess:
    return AgenticProcess(id=str(uuid.uuid4()), **kwargs)


@pytest.mark.asyncio
async def test_reconcile_stops_orphaned_headless_running():
    """A RUNNING headless worker (pty_mode=False) is stamped STOPPED."""
    proc = _proc(status=ProcessStatus.RUNNING.value, visible=False, pty_mode=False)
    await proc.save()

    await reconcile_orphaned_workers()

    reloaded = await AgenticProcess.get_by_id(proc.id)
    assert reloaded is not None
    assert reloaded.status == ProcessStatus.STOPPED.value


@pytest.mark.asyncio
async def test_reconcile_stops_orphaned_headless_starting():
    """A STARTING headless worker (pty_mode=False) is also a dead orphan → STOPPED."""
    proc = _proc(status=ProcessStatus.STARTING.value, visible=False, pty_mode=False)
    await proc.save()

    await reconcile_orphaned_workers()

    reloaded = await AgenticProcess.get_by_id(proc.id)
    assert reloaded is not None
    assert reloaded.status == ProcessStatus.STOPPED.value


@pytest.mark.asyncio
async def test_reconcile_leaves_visible_pty_running():
    """Visible PTYs belong to run_pty_recovery (respawn) — the sweep must not touch them."""
    proc = _proc(status=ProcessStatus.RUNNING.value, visible=True, pty_mode=True)
    await proc.save()

    await reconcile_orphaned_workers()

    reloaded = await AgenticProcess.get_by_id(proc.id)
    assert reloaded is not None
    assert reloaded.status == ProcessStatus.RUNNING.value


@pytest.mark.asyncio
async def test_reconcile_leaves_hidden_live_pty_running():
    """A hidden live PTY (visible=False, pty_mode=True) is a PTY-transport worker —
    reconcile must NOT stamp it STOPPED; run_pty_recovery owns its respawn.

    Fails pre-fix: the sweep keyed on ``visible`` and stamped this recoverable
    session STOPPED (killing it)."""
    proc = _proc(status=ProcessStatus.RUNNING.value, visible=False, pty_mode=True)
    await proc.save()

    await reconcile_orphaned_workers()

    reloaded = await AgenticProcess.get_by_id(proc.id)
    assert reloaded is not None
    assert reloaded.status == ProcessStatus.RUNNING.value


@pytest.mark.asyncio
async def test_reconcile_leaves_already_terminal_untouched():
    """An already-STOPPED headless row is left exactly as-is (idempotent)."""
    proc = _proc(status=ProcessStatus.STOPPED.value, visible=False, pty_mode=False)
    await proc.save()

    await reconcile_orphaned_workers()

    reloaded = await AgenticProcess.get_by_id(proc.id)
    assert reloaded is not None
    assert reloaded.status == ProcessStatus.STOPPED.value


@pytest.mark.asyncio
async def test_run_pty_recovery_respawns_watched_hidden_live_pty(monkeypatch):
    """run_pty_recovery must respawn a watched dead PTY keyed on pty_mode=True even
    when visible=False (hidden live PTY). Pre-fix it gated on ``visible`` and
    skipped it, leaving the session dead.

    Uses a real watched entity + real DB; ``start_pty`` (which would spawn a real
    worker) is the single stubbed seam so the test stays fast and driver-free — the
    assertion is purely that recovery reaches the respawn owner for this row."""
    proc = _proc(
        status=ProcessStatus.RUNNING.value,
        visible=False,
        pty_mode=True,
        shell_id=str(uuid.uuid4()),
    )
    await proc.save()
    watch_key = f"agentic_process:{proc.id}"
    add_watch("conn-recovery-test", watch_key)

    respawned: list[str] = []

    async def fake_start_pty(self, *args, **kwargs):
        respawned.append(self.id)
        return ApiSuccessResponse(data={"id": self.id})

    monkeypatch.setattr(AgenticProcess, "start_pty", fake_start_pty)

    try:
        await run_pty_recovery()
    finally:
        remove_watch("conn-recovery-test", watch_key)

    assert proc.id in respawned, "hidden live PTY (pty_mode=True) must be eligible for respawn"


@pytest.mark.asyncio
async def test_run_pty_recovery_skips_headless(monkeypatch):
    """A headless worker (pty_mode=False) is never respawned by run_pty_recovery —
    it is owned by reconcile_orphaned_workers."""
    proc = _proc(
        status=ProcessStatus.RUNNING.value,
        visible=False,
        pty_mode=False,
        shell_id=str(uuid.uuid4()),
    )
    await proc.save()
    watch_key = f"agentic_process:{proc.id}"
    add_watch("conn-recovery-test-2", watch_key)

    respawned: list[str] = []

    async def fake_start_pty(self, *args, **kwargs):
        respawned.append(self.id)
        return ApiSuccessResponse(data={"id": self.id})

    monkeypatch.setattr(AgenticProcess, "start_pty", fake_start_pty)

    try:
        await run_pty_recovery()
    finally:
        remove_watch("conn-recovery-test-2", watch_key)

    assert proc.id not in respawned, "headless worker must not be PTY-respawned"
