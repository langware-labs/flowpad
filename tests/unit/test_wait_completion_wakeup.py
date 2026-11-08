import asyncio
import time
import pytest
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess, register_prompt_task

@pytest.mark.asyncio
async def test_wait_wakes_when_local_turn_finishes():
    process = AgenticProcess(worker_type='claude_code', pty_mode=False)
    async def finish():
        await asyncio.sleep(0)
        process.status = 'failed'
    task = asyncio.create_task(finish())
    register_prompt_task(str(process.id), task)
    started = time.monotonic()
    await process.wait()
    assert time.monotonic() - started < 0.2

@pytest.mark.asyncio
async def test_cancelling_wait_preserves_worker_task():
    process = AgenticProcess(worker_type='claude_code', pty_mode=False)
    gate = asyncio.Event()
    task = asyncio.create_task(gate.wait())
    register_prompt_task(str(process.id), task)
    waiter = asyncio.create_task(process.wait())
    await asyncio.sleep(0)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert not task.cancelled()
    gate.set()
    await task
