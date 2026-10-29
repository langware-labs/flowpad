"""Startup prune keeps a schedule Trigger's job and drops every job no Trigger owns.

``Trigger`` is the only scheduling record: a jobstore entry whose id matches no
schedule-type Trigger is an orphan (a deleted trigger, an old random-id job, or
a leftover from the removed CronEvent entity) and must go.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

import flow_sdk.server.scheduler as scheduler_module
from flow_sdk.builtin.agent_schedule import add_schedule
from flow_sdk.server.scheduler import prune_orphan_scheduler_jobs
from tests.unit.agent._seed import seed_agent, seed_project

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


async def _noop() -> None:
    return None


@pytest.fixture
async def scheduler(monkeypatch):
    """A private, started scheduler in place of the instance singleton."""
    private = AsyncIOScheduler()
    private.start()
    monkeypatch.setattr(scheduler_module, "get_scheduler", lambda: private)
    yield private
    private.shutdown(wait=False)


async def test_prune_keeps_trigger_jobs_and_removes_orphans(tmp_path: Path, scheduler):
    project = await seed_project(tmp_path / "prune-project")
    agent = await seed_agent(Path(project.fs_storage_mount_path), "prune-agent", project_id=project.id)
    trigger = await add_schedule(agent, {"name": "Nightly", "every": "cron", "expr": "0 2 * * *", "prompt": "go"})
    scheduler.add_job(_noop, CronTrigger.from_crontab("0 3 * * *"), id="no-such-trigger")
    assert scheduler.get_job(trigger.id) is not None

    removed = await prune_orphan_scheduler_jobs()

    assert removed == 1
    assert scheduler.get_job("no-such-trigger") is None
    assert scheduler.get_job(trigger.id) is not None
