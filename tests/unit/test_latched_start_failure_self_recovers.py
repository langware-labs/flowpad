"""Regression: a latched ``start_failure`` whose underlying cause has since been
resolved must SELF-RECOVER on an ordinary (non-retry) start — the user must not
be forced to click Retry for a failure that is no longer real — WHILE a genuine
instant-exit latch still stays paused (the spawn→die→respawn loop breaker).

Proven root cause (this session, prod instance 9007, AP 476599d9):
  On 2026-06-24 the @local compute_node singleton was deleted out from under a
  session, so the launch raised "Compute node not found for local shell session
  (@local)" and latched a PERMANENT ``start_failure`` (status FAILED). The node
  was re-seeded on 2026-06-27 (it exists now), but the process is still stranded.

  Why a refresh can't heal it: the route loader opens a process by calling
  ``process.start({visible:true})`` (load-process.ts) — a non-retry open. In the
  backend ``_perform_open`` checks the ``start_failure`` latch
  (agentic_process.py:919-926) and, on a non-retry call, returns "Process failed
  to start: ... Auto-relaunch is paused — use Retry to relaunch." *before* it
  ever reaches ``_get_or_create_shell`` -> ``_get_local_compute_node`` (the
  self-heal that recreates / finds the @local node). The recovery that would fix
  it lives one layer BELOW the gate that refuses to call it, so the latch can
  never tell "cause still broken" from "cause already healed" — both freeze until
  a human clicks Retry.

Fix under test: the gate re-evaluates a recoverable latch via
``_latched_failure_recovered()`` and, when the cause is now satisfiable, clears
it and proceeds on the ordinary open. Conservative — only the @local case is
recognised; instant-exit latches stay paused.

Real DB (session ``initialize_test_db`` fixture), real ``AgenticProcess`` +
real ``ComputeNode`` seeded the same way ``bootstrap()`` seeds it — no mocks of
the unit under test; the only setup is the genuine environmental precondition.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.agentic_process import (
    LOCAL_COMPUTE_NODE_MISSING_FAILURE as _LOCAL_NODE_LATCH,
)
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.responses.response import ApiFailResponse


async def _ensure_local_compute_node_present() -> None:
    """Establish the real post-heal precondition: the @local node is BACK.

    Seeds it through the same idempotent bootstrap helpers the app uses, so the
    launch's own ``_get_local_compute_node`` lookup resolves it — i.e. the
    latched cause is genuinely no longer true.
    """
    from flow_sdk.core.cache.entity_cache import uname_cache
    from flow_sdk.server.routes.bootstrap import (
        get_or_create_local_compute_node,
        get_or_create_local_project,
        get_or_create_local_user,
    )

    user = await get_or_create_local_user()
    project = await get_or_create_local_project(desktop_user=user)
    await get_or_create_local_compute_node(local_project=project, desktop_user=user)
    uname_cache.invalidate("compute_node", "local")
    assert await ComputeNode.get_by_uname("local") is not None


async def _kill_any_spawned_worker(process_id: str) -> None:
    """Teardown: the fixed gate proceeds past the refusal and may boot a real
    PTY worker. Tear it down so the unit test leaves no stray child."""
    proc = await AgenticProcess.get_by_id(process_id)
    if proc is None or not proc.shell_id:
        return
    try:
        from flow_sdk.builtin.shell import Shell

        shell = await Shell.get_by_id(proc.shell_id)
        if shell is not None:
            await shell.close()
    except Exception:
        pass


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_non_retry_start_self_recovers_resolved_latch() -> None:
    await _ensure_local_compute_node_present()

    # A process latched by the exact prod failure, persisted FAILED — as if it
    # stranded on 06-24 and the backend has since restarted with @local back.
    ap = AgenticProcess(
        id=str(uuid.uuid4()),
        workdir="/tmp",
        tab_order=1,
        status=ProcessStatus.FAILED.value,
        start_failure=_LOCAL_NODE_LATCH,
    )
    await ap.save()

    try:
        # Exactly what a refresh does: the loader opens via a plain non-retry
        # start. The cause is gone, so this must recover — not refuse.
        result = await ap.start_pty(retry=False)

        refused = (
            isinstance(result, ApiFailResponse)
            and "Auto-relaunch is paused" in (result.message or "")
        )
        # BUG (pre-fix): the latch gate returns the paused-refusal before the
        # @local self-heal runs, stranding a recoverable latch until manual Retry.
        assert not refused, (
            "non-retry start refused a latched process whose @local cause is "
            f"already resolved, instead of self-recovering. response={result!r}"
        )

        # The stale @local latch must NOT survive frozen on the row. Spawn-
        # independent: after the fix it is cleared (None on a clean boot) or
        # replaced by a genuine NEW failure if the worker itself can't start —
        # either way it is never the resolved-cause string left frozen.
        reloaded = await AgenticProcess.get_by_id(ap.id)
        assert reloaded is not None
        assert reloaded.start_failure != _LOCAL_NODE_LATCH, (
            "resolved @local start_failure latch must not stay frozen on a "
            f"non-retry start, but it is still latched: {reloaded.start_failure!r}"
        )
    finally:
        await _kill_any_spawned_worker(ap.id)


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_instant_exit_latch_stays_paused_on_refresh() -> None:
    """Loop-breaker guard: a genuine instant-exit latch is NOT auto-recoverable,
    so a non-retry refresh must still refuse it (only manual Retry re-arms).
    This pins that the fix did not over-broaden into re-introducing the
    spawn→die→respawn storm."""
    await _ensure_local_compute_node_present()

    ap = AgenticProcess(
        id=str(uuid.uuid4()),
        workdir="/tmp",
        tab_order=1,
        status=ProcessStatus.FAILED.value,
        start_failure="Worker exited 0.9s after launch (exit code 1).",
    )
    await ap.save()

    result = await ap.start_pty(retry=False)

    assert isinstance(result, ApiFailResponse), f"expected refusal, got {result!r}"
    assert "Auto-relaunch is paused" in (result.message or ""), (
        "a genuine instant-exit latch must stay paused on a non-retry refresh — "
        f"only manual Retry clears it. response={result!r}"
    )
    # And the latch must remain intact (untouched), not cleared.
    reloaded = await AgenticProcess.get_by_id(ap.id)
    assert reloaded is not None
    assert reloaded.start_failure == "Worker exited 0.9s after launch (exit code 1)."
