"""Live: a headless chat's cron job keeps firing — its worker stays alive for it (FLOWPAD-2271).

A ``CronCreate`` job lives inside the ``claude -p`` process and fires only while it runs. The
worker used to close stdin at the first ``idle`` (a cron job is not in ``background_tasks_changed``),
so the process exited and the job with it: an hourly QA check fired once and never again
(2026-10-15). Against a real backend and a real ``claude``, this test proves the three edges:

1. the agent schedules a every-minute job and ends its turn → the worker stays parked
   (``background_work``) and the job fires again and again;
2. the worker is stopped → the next message resumes the session, Claude restores the job without
   announcing it, and the new worker stays parked for it (read from the transcript) — fires resume;
3. the agent deletes the job → nothing keeps the worker, the process lets go.

Each fire appends a line to a file, so a fire is counted on disk, not inferred.

Run against a DEDICATED instance (never the main dev backend)::

    DEEP_TESTING=true FLOWPAD_HUB_URL=http://localhost:6007 \\
        uv run pytest tests/long_tests/test_headless_scheduled_jobs.py -v -s
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import httpx
import pytest

from flow_sdk.builtin.agentic_process.model_tiers import ModelTier
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.asyncio,
]

HUB_URL = os.environ.get("FLOWPAD_HUB_URL")

#: An every-minute job runs late by up to half its gap (Claude Code's jitter): a fire every 60-90s.
FIRE_WAIT_SECONDS = 150
#: After the job is deleted: the agent's turn ends and the worker lets go.
SETTLE_SECONDS = 120


@pytest.fixture
async def hub_and_node():
    if not HUB_URL:
        pytest.skip(
            "FLOWPAD_HUB_URL not set — point this e2e test at a DEDICATED instance "
            "(scripts/instance_ctl.sh launch <name>), never the main dev backend."
        )
    client = httpx.AsyncClient(base_url=HUB_URL, timeout=httpx.Timeout(10.0, read=300.0))
    try:
        try:
            r = await client.get("/api/v1/graph/bootstrap", params={"domain": "localhost"})
        except httpx.ConnectError:
            pytest.skip(f"hub not reachable at {HUB_URL}")
        if r.status_code != 200:
            pytest.skip(f"hub bootstrap {r.status_code}")
        node_id = ((r.json().get("data") or {}).get("default_compute_node") or {}).get("id")
        if not node_id:
            pytest.skip("no default compute node in bootstrap")
        yield client, node_id
    finally:
        await client.aclose()


async def _process(client: httpx.AsyncClient, process_id: str) -> dict:
    payload = (await client.get(f"/api/v1/graph/agentic_process/{process_id}")).json()
    return payload.get("data") or payload


async def _prompt(client: httpx.AsyncClient, process_id: str, message: str) -> int:
    async with client.stream(
        "POST", f"/api/v1/graph/agentic_process/{process_id}/prompt", json={"message": message}
    ) as r:
        async for _ in r.aiter_bytes():
            pass
        return r.status_code


def _fires(log: Path) -> int:
    return len(log.read_text(encoding="utf-8").splitlines()) if log.exists() else 0


async def _wait_for_fires(client, process_id: str, log: Path, count: int) -> None:
    """``count`` more fires land, and between them the worker stays parked on the job."""
    target = _fires(log) + count
    deadline = time.monotonic() + count * FIRE_WAIT_SECONDS
    while _fires(log) < target:
        process = await _process(client, process_id)
        assert process.get("busy") or process.get("background_work"), (
            f"the worker let go with the job still scheduled ({_fires(log)} fires): {process.get('status')}"
        )
        assert time.monotonic() < deadline, f"the job stopped firing: {_fires(log)}/{target} fires"
        await asyncio.sleep(5)


async def _settled(client, process_id: str) -> dict:
    deadline = time.monotonic() + SETTLE_SECONDS
    while True:
        process = await _process(client, process_id)
        if not process.get("busy") and not process.get("background_work"):
            return process
        assert time.monotonic() < deadline, f"the worker never let go: {process}"
        await asyncio.sleep(5)


async def test_a_headless_cron_job_keeps_firing_survives_resume_and_ends_when_deleted(hub_and_node, tmp_path):
    client, node_id = hub_and_node
    log = tmp_path / "fires.log"
    r = await client.post(
        f"/api/v1/graph/compute_node/{node_id}/createProcess",
        json={
            "context": {
                "workdir": str(tmp_path),
                "output_format": "stream-json",
                "permission_mode": "bypassPermissions",
                "model": ModelTier.SM.value,
            },
            "visible": False,
            "pty_mode": False,
        },
    )
    assert r.status_code == 200, f"createProcess {r.status_code}: {r.text[:500]}"
    process_id = (r.json().get("data") or r.json())["id"]
    assert (await _process(client, process_id)).get("pty_mode") is False

    try:
        # 1. Scheduled, the turn ends, and the job keeps firing.
        status = await _prompt(
            client,
            process_id,
            "Use the CronCreate tool (load it with ToolSearch first if needed) to schedule a RECURRING job "
            "with cron '* * * * *' and this prompt, exactly:\n"
            f"Run this with the Bash tool: date +%T >> {log.as_posix()} — then reply with the single word: tick\n"
            "Do not run it yourself now. Reply with the single word: scheduled",
        )
        assert status == 200
        await _wait_for_fires(client, process_id, log, 2)

        # 2. The worker goes; the next message resumes the session and Claude restores the job.
        r = await client.post(f"/api/v1/graph/agentic_process/{process_id}/stop-background", json={})
        assert r.status_code == 200, f"stop-background {r.status_code}: {r.text[:300]}"
        await _settled(client, process_id)
        assert await _prompt(client, process_id, "Reply with the single word: ok") == 200
        await _wait_for_fires(client, process_id, log, 1)

        # 3. Deleted: nothing keeps the worker any more.
        assert (
            await _prompt(
                client,
                process_id,
                "Delete every scheduled job with the CronDelete tool (CronList shows their ids). "
                "Reply with the single word: deleted",
            )
            == 200
        )
        await _settled(client, process_id)
        fires = _fires(log)
        await asyncio.sleep(FIRE_WAIT_SECONDS)
        assert _fires(log) == fires, "the job still fired after it was deleted"
    finally:
        await client.post(f"/api/v1/graph/agentic_process/{process_id}/stop-background", json={})
