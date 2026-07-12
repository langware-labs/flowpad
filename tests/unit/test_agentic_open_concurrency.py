"""C15-3: concurrent ``open`` requests must serialize on the per-process
``_OPEN_LOCKS`` lock and produce exactly ONE worker spawn.

``start_pty`` is the single locked entry to ``_perform_open`` — every spawn
initiator (HTTP ``open``, ``switch-mode`` INTERACTIVE, restart, the
``pty_recovery`` watchdog) routes through it. This test pins the lock's
contract with a deterministic interleave: ``_perform_open`` is replaced by a
contract-faithful stand-in (RUNNING+shell ⇒ reattach, else yield-then-spawn)
whose ``await`` points are exactly where an UNLOCKED concurrent entry would
interleave. Without the lock both callers read the pre-spawn state and both
spawn (and the overlap detector trips); with it, one spawns and the other
reattaches to the same shell.
"""

import asyncio
import uuid
from unittest.mock import patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.responses.response import ApiSuccessResponse


@pytest.mark.asyncio
async def test_concurrent_opens_spawn_exactly_one_worker():
    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        status=ProcessStatus.STOPPED.value,
        visible=False,
        pty_mode=False,
    )
    await proc.save()

    spawned_shell_ids: list[str] = []
    in_flight = 0
    overlapped = False

    async def fake_perform_open(self, instruction, visible, retry=False):
        nonlocal in_flight, overlapped
        in_flight += 1
        try:
            if in_flight > 1:
                overlapped = True
            if self.status == ProcessStatus.RUNNING.value and self.shell_id:
                # Contract: a live worker is reattached, never re-spawned.
                return ApiSuccessResponse(
                    data={"mode": "reattach", "shell_id": self.shell_id}
                )
            # Yield points between the state read and the RUNNING save — an
            # unlocked concurrent entry interleaves here and double-spawns.
            for _ in range(3):
                await asyncio.sleep(0)
            self.shell_id = str(uuid.uuid4())
            self.status = ProcessStatus.RUNNING.value
            await self.save()
            spawned_shell_ids.append(self.shell_id)
            return ApiSuccessResponse(data={"mode": "spawn", "shell_id": self.shell_id})
        finally:
            in_flight -= 1

    with patch.object(AgenticProcess, "_perform_open", new=fake_perform_open):
        result_a, result_b = await asyncio.gather(proc.start_pty(), proc.start_pty())

    assert not overlapped, "two _perform_open bodies ran concurrently — open lock not held"
    assert isinstance(result_a, ApiSuccessResponse)
    assert isinstance(result_b, ApiSuccessResponse)
    # Exactly one spawn; the loser of the race reattaches to the SAME shell.
    assert len(spawned_shell_ids) == 1
    assert {result_a.data["mode"], result_b.data["mode"]} == {"spawn", "reattach"}
    assert result_a.data["shell_id"] == result_b.data["shell_id"] == spawned_shell_ids[0]
