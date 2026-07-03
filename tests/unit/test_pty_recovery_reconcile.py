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
@pytest.mark.parametrize(
    "status, visible, pty_mode, expected",
    [
        # Orphaned headless workers (pty_mode=False) are stamped STOPPED …
        (ProcessStatus.RUNNING, False, False, ProcessStatus.STOPPED),
        (ProcessStatus.STARTING, False, False, ProcessStatus.STOPPED),
        # … PTY-transport workers belong to run_pty_recovery — left untouched.
        # (visible PTY, and the hidden-live PTY that pre-fix was wrongly killed)
        (ProcessStatus.RUNNING, True, True, ProcessStatus.RUNNING),
        (ProcessStatus.RUNNING, False, True, ProcessStatus.RUNNING),
        # Already-terminal headless row is idempotent.
        (ProcessStatus.STOPPED, False, False, ProcessStatus.STOPPED),
    ],
    ids=[
        "headless-running->stopped",
        "headless-starting->stopped",
        "visible-pty-untouched",
        "hidden-live-pty-untouched",
        "already-terminal-idempotent",
    ],
)
async def test_reconcile_orphaned_workers_keys_on_pty_mode(status, visible, pty_mode, expected):
    """The startup sweep stamps orphaned *headless* workers STOPPED and leaves
    *PTY-transport* workers (``pty_mode=True``, any ``visible``) for
    ``run_pty_recovery``. The split MUST key on ``pty_mode``, not ``visible`` —
    the hidden-live-PTY case fails pre-fix (the sweep keyed on ``visible`` and
    killed a recoverable session)."""
    proc = _proc(status=status.value, visible=visible, pty_mode=pty_mode)
    await proc.save()

    await reconcile_orphaned_workers()

    reloaded = await AgenticProcess.get_by_id(proc.id)
    assert reloaded is not None
    assert reloaded.status == expected.value


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "pty_mode, should_respawn",
    [(True, True), (False, False)],
    ids=["hidden-live-pty-respawned", "headless-skipped"],
)
async def test_run_pty_recovery_keys_on_pty_mode(pty_mode, should_respawn, monkeypatch):
    """run_pty_recovery respawns a watched dead PTY keyed on ``pty_mode=True`` even
    when ``visible=False`` (hidden live PTY), and never respawns a headless worker
    (``pty_mode=False``, owned by reconcile). Pre-fix it gated on ``visible`` and
    skipped the hidden live PTY.

    Real watched entity + real DB; ``start_pty`` (which would spawn a real worker)
    is the single stubbed seam so the assertion is purely that recovery reaches
    the respawn owner for this row."""
    proc = _proc(
        status=ProcessStatus.RUNNING.value,
        visible=False,
        pty_mode=pty_mode,
        shell_id=str(uuid.uuid4()),
    )
    await proc.save()
    watch_key = f"agentic_process:{proc.id}"
    watcher = f"conn-recovery-test:{proc.id}"
    add_watch(watcher, watch_key)

    respawned: list[str] = []

    async def fake_start_pty(self, *args, **kwargs):
        respawned.append(self.id)
        return ApiSuccessResponse(data={"id": self.id})

    monkeypatch.setattr(AgenticProcess, "start_pty", fake_start_pty)

    try:
        await run_pty_recovery()
    finally:
        remove_watch(watcher, watch_key)

    assert (proc.id in respawned) is should_respawn
