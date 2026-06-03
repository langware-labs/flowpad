"""Phase-0 characterization: locks the current `_terminal_list` MEMBERSHIP rule
(ComputeNode) before it is generalized into the `tabbed`-based `tabs/list`.

Today the strip is `pure_shells ∪ visible_processes`:
  - pure_shells: shells NOT owned by any AgenticProcess (via shell_id or
    sidecar_shell_id) and not in a terminal status (CLOSING/CLOSED/ERROR).
  - visible_processes: AgenticProcesses with `visible == true`.

`reap_if_orphaned` is patched to a no-op so the test exercises only membership
filtering (the reaping side effect is orthogonal and PTY-bound).

Entity-level direct call (no HTTP) — same convention as tests/unit/test_shell_api.py.
"""
import uuid
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.shell import Shell, ShellStatus

# Records root is isolated per-test by the autouse `isolated_records_root`
# fixture in tests/conftest.py — no local fixture needed.


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_terminal_list_membership():
    plain = Shell(id=str(uuid.uuid4()), status="running", tab_order=0)
    closing = Shell(id=str(uuid.uuid4()), status=ShellStatus.CLOSING.value, tab_order=1)
    owned = Shell(id=str(uuid.uuid4()), status="running", tab_order=2)
    sidecar = Shell(id=str(uuid.uuid4()), status="running", tab_order=3)
    for s in (plain, closing, owned, sidecar):
        await s.save()

    visible_ap = AgenticProcess(
        id=str(uuid.uuid4()), visible=True, shell_id=owned.id, sidecar_shell_id=sidecar.id
    )
    hidden_ap = AgenticProcess(id=str(uuid.uuid4()), visible=False)
    for p in (visible_ap, hidden_ap):
        await p.save()

    with patch.object(AgenticProcess, "reap_if_orphaned", new=AsyncMock(return_value=False)):
        res = await ComputeNode()._terminal_list()

    data = res.data
    pure_ids = {s["id"] for s in data["pure_shells"]}
    visible_ids = {p["id"] for p in data["visible_processes"]}

    # pure_shells: only the plain, non-owned, non-terminal shell
    assert plain.id in pure_ids
    assert closing.id not in pure_ids          # terminal status excluded
    assert owned.id not in pure_ids            # owned by an AP (shell_id) excluded
    assert sidecar.id not in pure_ids          # sidecar of an AP excluded

    # visible_processes: only the visible AP
    assert visible_ap.id in visible_ids
    assert hidden_ap.id not in visible_ids
