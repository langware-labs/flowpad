"""Regression: an AgenticProcess launch must AUTO-RECOVER the @local compute
node when it is absent — the same way the frontend expects a relaunch to "just
work" — instead of stranding the session.

Proven root cause (this session, prod instance 9007):
  The @local compute_node is a fileless singleton that gets deleted out from
  under running sessions (id churned fc6564f8 -> d6978791; "Creating @local
  compute node" logged 4x). Unlike the @local user/project, the compute node is
  only re-seeded by the app-boot ``bootstrap()``. So during the gap a launch
  reaches ``_get_or_create_shell`` -> ``_get_local_compute_node()`` which only
  does ``get_by_uname("local")`` + a cache-invalidate retry and then returns
  ``None`` -> the launch raises "Compute node not found for local shell session
  (@local)" -> ``_perform_open`` latches a PERMANENT ``start_failure``. 8 such
  stranded APs produce the "We skipped 8 sessions that couldn't be restored"
  modal at /dock/shell.

User's invariant: "if somehow we don't have the compute node we recover it, we
don't mark failure." This test pins that at the LAUNCH layer: the shell/compute
acquisition step the open path runs (``AgenticProcess._get_or_create_shell``,
the step right before the PTY worker is spawned) must recover the absent @local
node and return a shell — not raise the compute-node error.

Real DB (session ``initialize_test_db`` fixture), real ``AgenticProcess`` +
real ``Shell``/``ComputeNode``, real launch method — no mocks of the unit under
test, and no worker boot (the worker spawn lives in the caller, after this
step). The only setup establishes the genuine environmental precondition the
bug needs: the @local compute node is absent.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.faas.compute_node import ComputeNode


async def _ensure_local_compute_node_absent() -> None:
    """Establish the environmental precondition: no @local compute node.

    Removes any stray node a sibling test created — it does NOT touch the
    AgenticProcess (the row the bug strands). Absence of the compute node is the
    real-world condition proven in prod, not a forced AP state.
    """
    from flow_sdk.core.cache.entity_cache import uname_cache

    existing = await ComputeNode.get_by_uname("local")
    if existing is not None:
        await existing.delete()
    uname_cache.invalidate("compute_node", "local")
    assert await ComputeNode.get_by_uname("local") is None


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_launch_auto_recovers_absent_local_compute_node() -> None:
    await _ensure_local_compute_node_absent()

    # A fresh process, exactly as a relaunch from the frontend arrives: a
    # workdir, no shell yet.
    ap = AgenticProcess(
        id=str(uuid.uuid4()),
        workdir="/tmp",
        tab_order=1,
    )

    # The launch's shell/compute acquisition step (runs inside the open path
    # the frontend drives, right before the worker is spawned).
    shell = await ap._get_or_create_shell()

    # BUG (current): _get_or_create_shell raises
    #   RuntimeError("Compute node not found for local shell session (@local)")
    # -> _perform_open latches a permanent start_failure -> session stranded.
    # EXPECTED: the launch auto-recovers the singleton and returns a shell.
    assert shell is not None
    assert getattr(shell, "compute_node_uname", None) == "local"
    # And the node must now be durably resolvable by the same lookup the launch
    # uses — i.e. it was recovered, not merely fabricated in memory.
    assert await ComputeNode.get_by_uname("local") is not None
