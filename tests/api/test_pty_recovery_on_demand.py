"""PTY recovery must be ON-DEMAND — no global "recover them all" sweep.

Regression for the prod crash: the backend crash-looped with

    OSError: out of pty devices

because on every restart ``run_pty_recovery`` (flow_sdk/server/pty_recovery.py)
enumerates EVERY AgenticProcess + Shell and respawns each dead PTY — at startup
AND every 5s (``start_recovery_task``). With many accumulated shells that fires
hundreds of ``openpty()`` calls at once and exhausts macOS ``kern.tty.ptmx_max``
(511).

Intended design (per user):
  1. a shell's PTY is recovered ON-DEMAND — only when its process is loaded and
     its PTY is found dead.
  2. there is NO global recover-it-all sweep on restart.

This drives the user's exact scenario at the narrowest faithful layer (real
entities, real DB + @local compute node, real zsh PTYs — no mocks):

  1. two bare shells exist, status=running, with NO live PTY — exactly the
     post-restart state (RUNNING on disk, empty in-memory PTY registry).
  2. run_pty_recovery() runs (the startup + watchdog sweep).
  3. neither shell — nobody loaded them — may have had a PTY spawned. A global
     sweep spawns both. That IS the bug.
  4. restart the PTY of ONE shell on demand → exactly that one is alive; the
     untouched one stays dead.

FAILS today at step 3: the global sweep respawns BOTH shells.
PASSES once recovery is on-demand only.
"""

import uuid

import pytest

from flow_sdk.builtin.shell import Shell, ShellStatus
from flow_sdk.server.pty_recovery import run_pty_recovery


def _compute_node_id(bootstrap_resp) -> str:
    return bootstrap_resp.json()["data"]["default_compute_node"]["id"]


async def _bootstrap_cn(client) -> str:
    resp = await client.get("/api/v1/graph/bootstrap")
    assert resp.status_code == 200
    return _compute_node_id(resp)


async def _make_running_shell(cn_id: str) -> Shell:
    """A shell that DB-thinks it is running but has no live PTY — the exact state
    a restart leaves behind (RUNNING row + empty in-memory PTY registry)."""
    shell = Shell(
        id=str(uuid.uuid4()),
        name="orphan-shell",
        compute_node_id=cn_id,
        status=ShellStatus.RUNNING.value,
    )
    await shell.save()
    return shell


async def _kill_pty(shell: Shell) -> None:
    pty = shell.compute_node.get_pty(shell.id)
    if pty:
        await pty.kill()


@pytest.mark.asyncio
async def test_recovery_does_not_globally_respawn_unloaded_shells(bootstrapped_client):
    """run_pty_recovery must NOT spawn a PTY for a shell nobody loaded."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    a = await _make_running_shell(cn_id)
    b = await _make_running_shell(cn_id)
    try:
        # Precondition: neither has a live PTY (never opened).
        assert await a.has_attachable_pty() is False
        assert await b.has_attachable_pty() is False

        # ── the startup / watchdog sweep ──
        await run_pty_recovery()

        # ── step 3: nobody loaded either shell, so recovery must not have
        # spawned a PTY for either. The global sweep spawns both — that is the
        # bug that exhausts the pty device pool on restart. ──
        assert await a.has_attachable_pty() is False, (
            "run_pty_recovery spawned a PTY for an unloaded shell (global sweep) — "
            "recovery must be on-demand"
        )
        assert await b.has_attachable_pty() is False, (
            "run_pty_recovery spawned a PTY for an unloaded shell (global sweep) — "
            "recovery must be on-demand"
        )

        # ── step 4: restart the PTY of ONE shell on demand → only that one is
        # alive; the untouched one stays dead. ──
        await a.start_pty()
        assert await a.has_attachable_pty() is True, "on-demand PTY restart should revive shell a"
        assert await b.has_attachable_pty() is False, "untouched shell b must stay dead"
    finally:
        await _kill_pty(a)
        await _kill_pty(b)
        await a.delete()
        await b.delete()
