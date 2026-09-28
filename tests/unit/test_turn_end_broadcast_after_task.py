"""The last word on a headless turn is broadcast after its task has really ended.

``end_headless_turn`` broadcasts from INSIDE the turn task, and ``is_turn_busy`` counts that
still-running task — so the terminal broadcast said ``busy: True, worker_status: complete``.
Nothing guaranteed a later one, and a Copilot chat whose turn ended on a tool call showed
"Working" until the next turn (new prompts queued behind the stale flag).
"""
from __future__ import annotations

import asyncio

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import prompt_task_active, register_prompt_task


@pytest.mark.asyncio
async def test_on_done_runs_once_the_task_no_longer_counts_as_active():
    seen: list[bool] = []

    async def on_done() -> None:
        seen.append(prompt_task_active("p-broadcast"))

    async def turn() -> None:
        await asyncio.sleep(0)

    task = asyncio.create_task(turn())
    register_prompt_task("p-broadcast", task, on_done=on_done)
    await task
    for _ in range(5):
        await asyncio.sleep(0)

    assert seen == [False], "the final broadcast must see the turn as over"
