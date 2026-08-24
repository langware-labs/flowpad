"""Integration: a queued prompt boots a real worker and is processed.

Queue of one. Parametrized PTY (visible=True) and headless (visible=False).
Both boot the worker WITH the queued prompt — deterministic, no boot-empty-
then-stdin race — but via different (correct) seams:

  * PTY: the dock loader calls ``start_pty()`` with no instruction; the
    fresh-spawn path in ``_perform_open`` pops the queue head and uses it as
    the launch arg. The enqueue drain deliberately does NOT cold-start a
    visible process (that would race the loader).
  * Headless: the enqueue action schedules ``_maybe_drain_queue``, which
    cold-starts the headless worker WITH the head via ``headless_prompt``.
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
from flow_sdk.builtin.agentic_process.model_tiers import ModelTier
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
        cli_config={"permission_mode": "bypassPermissions", "model": ModelTier.SM.value},
        workdir=str(tmp_path),
        visible=visible,
    )
    await process.save()

    sentinel = f"QUEUEOK{uuid.uuid4().hex[:8].upper()}"
    prompt = f"Reply with exactly the token {sentinel} and nothing else."

    try:
        # ── enqueue (queue of 1) — pure file, no worker yet ──
        process.queue.enqueue(prompt, source="ui")
        assert [e["prompt"] for e in process.queue.entries] == [prompt]
        assert process.queue.log_entries()[-1]["action"] == "enqueue"

        # ── boot the worker; the queued head feeds it as the launch prompt ──
        if visible:
            # PTY: loader path. start_pty() with no instruction → _perform_open
            # pops the head as the launch arg.
            await process.start_pty()
            process = await AgenticProcess.get_by_id(process.id)
            inject_source = "launch"
        else:
            # Headless: enqueue would schedule this; await it deterministically.
            await process._maybe_drain_queue("enqueue")
            inject_source = "enqueue"

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

        # ── log proves the head was consumed exactly once, in order:
        #    enqueue → pop → inject → injected (headless also logs drain_check(ok)) ──
        logs = process.queue.log_entries()
        actions = [line["action"] for line in logs]
        assert actions.count("inject") == 1, f"expected exactly one inject, got {actions}"
        i_enq = actions.index("enqueue")
        i_pop = actions.index("pop")
        i_inj = actions.index("inject")
        i_done = actions.index("injected")
        assert i_enq < i_pop < i_inj < i_done, f"log out of order: {actions}"
        # the inject line carries the right source + our prompt
        inject_line = logs[i_inj]
        assert inject_line.get("source") == inject_source, inject_line
        assert sentinel in inject_line.get("prompt", "")
        if not visible:
            i_ok = next(i for i, line in enumerate(logs)
                        if line["action"] == "drain_check" and line.get("reason") == "ok")
            assert i_enq < i_ok < i_pop, f"drain_check(ok) misordered: {actions}"
    finally:
        await process.close()
