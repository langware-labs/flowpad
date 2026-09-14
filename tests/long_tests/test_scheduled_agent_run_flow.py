"""LIVE: a scheduled agent run, end to end, against a running backend.

The whole chain with nothing stubbed: an agent is created in a project, a
schedule is added to it set ONE SECOND ahead, and the real APScheduler fires it,
which runs the real agent headlessly through its local Deployment. Judged on
artifacts only — the child ``trigger.json`` on disk, the trigger row, the
process row, the run list — never on what the agent says.

Also proves the two negatives that matter: a disabled schedule does not fire,
and removing a schedule takes its folder, row and job.

Target: ``SCHEDULE_E2E_API_URL`` (or ``QA_API_URL``), else
``http://127.0.0.1:$LOCAL_SERVER_PORT``. Launch one with
``scripts/instance_ctl.sh launch <name>`` from this checkout. Skips when no
backend answers.

Budget: 240 s for the test — the fire itself must land within seconds; the rest
is one real haiku turn. Do not raise it.
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.timeout(240),  # budget — do not raise
]

BASE = (
    os.environ.get("SCHEDULE_E2E_API_URL")
    or os.environ.get("QA_API_URL")
    or f"http://127.0.0.1:{os.environ.get('LOCAL_SERVER_PORT', '9007')}"
)

#: How late a fire may land after its scheduled second. The scheduler wakes on
#: time; anything beyond this is a stalled event loop, which is a bug.
FIRE_SLACK_S = 5.0


async def _data(client: httpx.AsyncClient, method: str, path: str, **kw):
    resp = await client.request(method, path, **kw)
    body = resp.json()
    assert body.get("status") == "SUCCESS", (method, path, resp.status_code, resp.text[:500])
    return body["data"]


async def _until(predicate, *, budget_s: float, every_s: float = 0.25):
    """Sample until ``predicate()`` is truthy or the budget is spent."""
    deadline = time.monotonic() + budget_s
    while True:
        value = await predicate()
        if value:
            return value
        if time.monotonic() >= deadline:
            return None
        await asyncio.sleep(every_s)


async def _runs(client: httpx.AsyncClient, trigger_id: str) -> list[dict]:
    return (await _data(client, "GET", f"/api/v1/runs?trigger_id={trigger_id}"))["runs"]


async def test_a_schedule_one_second_ahead_runs_the_agent_headlessly(tmp_path: Path):
    async with httpx.AsyncClient(base_url=BASE, timeout=httpx.Timeout(10.0, read=60.0)) as client:
        try:
            await client.get("/api/v1/graph/bootstrap")
        except httpx.HTTPError:
            pytest.skip(f"no backend at {BASE}")

        suffix = uuid.uuid4().hex[:8]
        project_root = tmp_path / f"sched-e2e-{suffix}"
        project_root.mkdir(parents=True)
        project = await _data(client, "POST", "/api/v1/graph/project", json={
            "type": "project", "name": project_root.name, "fs_storage_mount_path": str(project_root),
        })
        agent_name = f"sched-e2e-{suffix}"
        agent = await _data(client, "POST", f"/api/v1/graph/project/{project['id']}/agent", json={
            "type": "agent",
            "name": agent_name,
            "worker_type": "claude",
            "model": "haiku",
            "system_prompt": "You are a terse test agent. Answer in one word.",
        })
        agent_id = agent["id"]
        agent_folder = Path(agent["asset_ref"])
        prompt = "Reply with the single word: scheduled"

        # ── add: one second ahead ───────────────────────────────────────────
        fire_at = datetime.now(timezone.utc) + timedelta(seconds=1)
        trigger = await _data(client, "POST", f"/api/v1/graph/agent/{agent_id}/add_schedule", json={
            "name": "One second ahead",
            "every": "date",
            "expr": fire_at.isoformat(),
            "timezone": "UTC",
            "prompt": prompt,
        })
        trigger_id = trigger["id"]
        document = agent_folder / "agentic-assets" / "trigger" / "one-second-ahead" / "trigger.json"
        assert document.is_file(), "the schedule must be a child asset of the agent"
        assert trigger["parent_type_id"] == f"agent-{agent_id}"
        assert trigger["trigger_type"] == "schedule"

        # ── the real scheduler fires it ─────────────────────────────────────
        runs = await _until(lambda: _runs(client, trigger_id), budget_s=1.0 + FIRE_SLACK_S)
        fired_after = (datetime.now(timezone.utc) - fire_at).total_seconds()
        assert runs, f"the schedule did not fire within {FIRE_SLACK_S}s of its time"
        assert len(runs) == 1, runs
        run = runs[0]
        assert run["agent"] == agent_name
        assert run["trigger_id"] == trigger_id
        assert run["prompt"] == prompt

        fired = await _data(client, "GET", f"/api/v1/graph/trigger/{trigger_id}")
        assert fired["counter"] == 1
        assert fired["last_run"]

        # ── it is a real headless run of THIS agent ─────────────────────────
        process = await _data(client, "GET", f"/api/v1/graph/agentic_process/{run['id']}")
        assert process["context_data"]["trigger_id"] == trigger_id
        assert process["context_data"]["launched_by_agent"] == agent_name
        assert process["pty_mode"] is False, "a scheduled run is headless"
        assert process["visible"] is False, "a scheduled run opens no tab"
        assert process["deployment_id"], "launched through the agent's deployment, not a bare process"

        # The fire log entry is written at the END of the fire, after the run row
        # (the process is saved inside the launch) — so it lags the run by a beat.
        async def _fire_entry():
            fires = await _data(client, "GET", "/api/v1/graph/trigger/fires?limit=200")
            return next((f for f in fires if f.get("trigger_id") == trigger_id), None)

        entry = await _until(_fire_entry, budget_s=FIRE_SLACK_S)
        assert entry is not None, "the fire left no trigger-log entry"
        assert entry.get("agentic_process_id") == run["id"], entry

        async def _finished():
            row = await _data(client, "GET", f"/api/v1/runs/{run['id']}")
            row = row.get("run", row)
            return row if row.get("badge") in ("done", "failed") else None

        finished = await _until(_finished, budget_s=180.0, every_s=2.0)
        assert finished is not None, "the scheduled run never finished"
        assert finished["badge"] == "done", finished

        # ── a disabled schedule does not fire ───────────────────────────────
        quiet_at = datetime.now(timezone.utc) + timedelta(seconds=1)
        quiet = await _data(client, "POST", f"/api/v1/graph/agent/{agent_id}/add_schedule", json={
            "name": "Disabled one second ahead",
            "every": "date",
            "expr": quiet_at.isoformat(),
            "timezone": "UTC",
            "prompt": prompt,
            "enabled": False,
        })
        await asyncio.sleep(1.0 + FIRE_SLACK_S)
        assert await _runs(client, quiet["id"]) == []
        assert (await _data(client, "GET", f"/api/v1/graph/trigger/{quiet['id']}"))["counter"] == 0

        # ── remove takes folder, row and job ────────────────────────────────
        for tid, folder in ((trigger_id, document.parent), (quiet["id"], None)):
            await _data(client, "POST", f"/api/v1/graph/agent/{agent_id}/remove_schedule", json={"trigger_id": tid})
            gone = await client.get(f"/api/v1/graph/trigger/{tid}")
            assert gone.json().get("status") != "SUCCESS" or not gone.json().get("data"), gone.text[:300]
            if folder is not None:
                assert not folder.exists()
        # The run history outlives the schedule that started it.
        assert len(await _runs(client, trigger_id)) == 1
        print(f"\nscheduled run fired {fired_after:.2f}s after its time; run {run['id']} finished")
