"""Integration: a queued prompt is drained into a real worker and processed.

Queue of one. Parametrized PTY (visible=True) and headless (visible=False).
The drain boots the worker WITH the queued prompt (launch arg / headless_prompt),
so it's deterministic — no boot-empty-then-stdin race.
"""
import json
import uuid

import pytest

from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.status_predicates import is_ready_for_input
from flow_sdk.builtin.faas.compute_node import ComputeNode


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.parametrize("visible", [True, False], ids=["pty", "headless"])
async def test_prompt_queue_drains_into_worker(bootstrapped_client, tmp_path, visible):
    cn = await ComputeNode.get_one({"uname": "local"})
    assert cn, "No @local compute node found"

    process = AgenticProcess(
        compute_node_id=f"compute_node-{cn.id}",
        cli_config={"permission_mode": "bypassPermissions"},
        workdir=str(tmp_path),
        visible=visible,
    )
    await process.save([])

    sentinel = f"QUEUEOK{uuid.uuid4().hex[:8].upper()}"
    prompt = f"Reply with exactly the token {sentinel} and nothing else."

    try:
        # ── enqueue (queue of 1) — pure file, no worker yet ──
        process.queue.enqueue(prompt, source="ui")
        assert [e["prompt"] for e in process.queue.entries] == [prompt]
        assert process.queue.log_entries()[-1]["action"] == "enqueue"

        # ── drain: cold-start boots the worker WITH the queued prompt ──
        # (the enqueue action would schedule this; here we await it deterministically)
        await process._maybe_drain_queue("enqueue")

        # ── drive the injected turn to completion + collect the transcript ──
        entries = []
        async for entry in process.stream_transcript(timeout=28):
            entries.append(entry)
        assert is_ready_for_input(process) is True, "worker not idle after the turn"

        # ── the queued prompt was fed to the worker (sentinel in its transcript) ──
        blob = json.dumps(entries)
        assert sentinel in blob, f"sentinel {sentinel} not in transcript ({len(entries)} entries)"

        # ── queue drained ──
        assert process.queue.entries == [], "queue not drained"

        # ── log proves the FIFO drain: enqueue → drain_check(ok) → pop → inject → injected ──
        logs = process.queue.log_entries()
        actions = [line["action"] for line in logs]
        assert actions.count("inject") == 1, f"expected exactly one inject, got {actions}"
        i_enq = actions.index("enqueue")
        i_ok = next(i for i, line in enumerate(logs)
                    if line["action"] == "drain_check" and line.get("reason") == "ok")
        i_pop = actions.index("pop")
        i_inj = actions.index("inject")
        i_done = actions.index("injected")
        assert i_enq < i_ok < i_pop < i_inj < i_done, f"log out of order: {actions}"
        # the injected prompt is the one we enqueued
        inject_line = logs[i_inj]
        assert sentinel in inject_line.get("prompt", "")
    finally:
        await process.close()
