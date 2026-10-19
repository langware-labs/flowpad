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
from contextlib import contextmanager

import pytest

from flow_sdk.app.actions.watch_registry import add_watch, remove_watch
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.builtin.shell import Shell, ShellStatus
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.server.pty_recovery import (
    mark_recovered,
    reconcile_orphaned_workers,
    run_pty_recovery,
    was_recovered,
)


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


# The ``recovered`` flag describes the respawned worker, so it goes with the
# process: it used to be kept for the backend lifetime, one id per recovered
# process, and a closed process kept sending ``recovered_msg`` to every new
# watcher (a pointless forced re-attach). Both lifecycle exits enter through
# the real ``close()`` / ``delete()``; the self-exit arm is covered in
# ``test_agentic_process/test_self_exit_releases_transcript_state.py``.


@pytest.mark.asyncio
async def test_delete_forgets_recovered():
    proc = _proc(status=ProcessStatus.STOPPED.value, visible=False, pty_mode=True)
    await proc.save()
    mark_recovered(proc.id)
    assert was_recovered(proc.id)

    await proc.delete()

    assert not was_recovered(proc.id)
    assert await AgenticProcess.get_by_id(proc.id) is None


@pytest.mark.asyncio
async def test_close_forgets_recovered():
    proc = _proc(status=ProcessStatus.RUNNING.value, visible=True, pty_mode=True)
    await proc.save()
    mark_recovered(proc.id)

    assert await proc.close() is True

    assert not was_recovered(proc.id)


# The tick runs every few seconds for as long as ANY watch exists, so it asks
# the database only for rows it can act on. These pin both halves: nothing is
# enumerated for watches that cannot need recovery, and the narrower queries
# still reach every row the tick acts on.


def _count_hydrated_rows(monkeypatch) -> dict:
    """Wrap the two real ``get_all`` entry points the tick reads through and
    record which rows each query hydrated and whether it carried a filter."""
    seen = {"ids": set(), "unfiltered_queries": 0}

    def _wrap(cls):
        real = cls.get_all.__func__

        async def _counting(klass, *args, **kwargs):
            if not args and kwargs.get("entities_filter") is None:
                seen["unfiltered_queries"] += 1
            rows = await real(klass, *args, **kwargs)
            seen["ids"].update(row.id for row in rows)
            return rows

        monkeypatch.setattr(cls, "get_all", classmethod(_counting))

    _wrap(AgenticProcess)
    _wrap(Shell)
    return seen


@contextmanager
def _watching(*keys: str):
    """One connection watching ``keys`` for the duration of the block."""
    watcher = f"conn-recovery-test:{uuid.uuid4()}"
    for key in keys:
        add_watch(watcher, key)
    try:
        yield
    finally:
        for key in keys:
            remove_watch(watcher, key)


def _shell(status: ShellStatus) -> Shell:
    return Shell(id=str(uuid.uuid4()), compute_node_id=str(uuid.uuid4()), status=status.value)


@pytest.mark.asyncio
async def test_tick_enumerates_nothing_when_only_ended_processes_are_watched(monkeypatch):
    """A watch on a finished agent keeps the tick running; with no live process
    and no running watched shell there is nothing it could recover, so it must
    not load the process or shell tables to find that out. The database is
    shared by the session, so the pin is on THIS test's rows: none is hydrated."""
    ended = []
    for _ in range(12):
        shell = _shell(ShellStatus.CLOSED)
        await shell.save()
        proc = _proc(status=ProcessStatus.STOPPED.value, pty_mode=True, shell_id=shell.id)
        await proc.save()
        ended.append(proc)
    seen = _count_hydrated_rows(monkeypatch)
    with _watching(f"agentic_process:{ended[0].id}", f"shell:{ended[1].shell_id}"):
        await run_pty_recovery()

    assert seen["unfiltered_queries"] == 0
    seeded = {proc.id for proc in ended} | {proc.shell_id for proc in ended}
    assert not seen["ids"] & seeded


@pytest.mark.asyncio
async def test_watched_bare_shell_is_recovered_but_never_a_process_owned_one(monkeypatch):
    """A watched RUNNING shell with a dead PTY is respawned as a bare terminal —
    unless a process owns it. Ownership holds in ANY lifecycle state: a fresh
    shell under a STOPPED worker would drop its ``--resume`` session, so that
    shell is left alone even though the live-process query never returns its
    owner."""
    bare, owned, unwatched = (_shell(ShellStatus.RUNNING) for _ in range(3))
    for shell in (bare, owned, unwatched):
        await shell.save()
    await _proc(status=ProcessStatus.STOPPED.value, pty_mode=True, shell_id=owned.id).save()

    respawned: list[str] = []

    async def fake_start_pty(self, *args, **kwargs):
        respawned.append(self.id)

    monkeypatch.setattr(Shell, "start_pty", fake_start_pty)
    with _watching(f"shell:{bare.id}", f"shell:{owned.id}"):
        await run_pty_recovery()

    assert respawned == [bare.id]


@pytest.mark.asyncio
async def test_watched_starting_pty_process_is_recovered_among_ended_rows(monkeypatch):
    """The live-process query keeps both live states: a STARTING PTY worker with
    a dead PTY, watched through its shell key, is respawned, while the ended and
    the unwatched rows around it are left alone."""
    starting = _proc(status=ProcessStatus.STARTING.value, pty_mode=True, shell_id=str(uuid.uuid4()))
    unwatched = _proc(status=ProcessStatus.RUNNING.value, pty_mode=True, shell_id=str(uuid.uuid4()))
    ended = _proc(status=ProcessStatus.STOPPED.value, pty_mode=True, shell_id=str(uuid.uuid4()))
    for proc in (starting, unwatched, ended):
        await proc.save()

    respawned: list[str] = []

    async def fake_start_pty(self, *args, **kwargs):
        respawned.append(self.id)
        return ApiSuccessResponse(data={"id": self.id})

    monkeypatch.setattr(AgenticProcess, "start_pty", fake_start_pty)
    with _watching(f"shell:{starting.shell_id}", f"agentic_process:{ended.id}"):
        await run_pty_recovery()

    assert respawned == [starting.id]
