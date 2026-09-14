"""H1: _fire_schedule_job now dispatches the trigger's actions list through
the action handler registry (previously: only the legacy `instruction` path
ran). Verifies CALLBACK + RUN_SCRIPT dispatch + per-action failure isolation.
"""
from __future__ import annotations

import asyncio

import pytest

from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.trigger import Trigger, _fire_schedule_job
from flow_sdk.schema.data_spec.trigger_action import ActionType, TriggerAction
from flow_sdk.schema.data_spec.trigger_types import TriggerType

pytestmark = pytest.mark.timeout(30)


@pytest.fixture(autouse=True)
def _isolated_callback_registry(monkeypatch):
    """Snapshot + restore — keeps real builtin callbacks intact across the test."""
    snapshot = dict(trigger_callbacks._handlers)
    yield
    trigger_callbacks._handlers.clear()
    trigger_callbacks._handlers.update(snapshot)


@pytest.mark.asyncio
async def test_callback_action_dispatched_on_schedule_fire(initialize_test_db) -> None:
    """CALLBACK action on a SCHEDULE trigger runs when the trigger fires."""
    runs: list[str] = []

    @trigger_callbacks.register("test_schedule_cb")
    async def _cb(_trigger, _changes) -> None:
        runs.append("cb-fired")

    trigger = await Trigger(
        name="test_schedule_dispatch",
        trigger_type=TriggerType.SCHEDULE,
        sched_trigger_type="cron",
        expr="* * * * *",
        actions=[TriggerAction(
            action_type=ActionType.CALLBACK,
            callback_name="test_schedule_cb",
        )],
    ).save()

    await _fire_schedule_job(trigger.id)

    assert runs == ["cb-fired"]
    refreshed = await Trigger.get_by_id(trigger.id)
    assert refreshed.counter == 1
    assert refreshed.last_run is not None


@pytest.mark.asyncio
async def test_one_failing_action_does_not_skip_siblings(initialize_test_db) -> None:
    runs: list[str] = []

    @trigger_callbacks.register("cb_crash")
    async def _crash(_t, _changes) -> None:
        raise RuntimeError("intentional")

    @trigger_callbacks.register("cb_ok")
    async def _ok(_t, _changes) -> None:
        runs.append("ok")

    trigger = await Trigger(
        name="test_fail_isolation",
        trigger_type=TriggerType.SCHEDULE,
        sched_trigger_type="cron",
        expr="* * * * *",
        actions=[
            TriggerAction(action_type=ActionType.CALLBACK, callback_name="cb_crash"),
            TriggerAction(action_type=ActionType.CALLBACK, callback_name="cb_ok"),
        ],
    ).save()

    await _fire_schedule_job(trigger.id)
    assert runs == ["ok"]


@pytest.mark.asyncio
async def test_disabled_trigger_no_dispatch(initialize_test_db) -> None:
    runs: list[str] = []

    @trigger_callbacks.register("cb_disabled_check")
    async def _cb(_t, _p, _c) -> None:
        runs.append("should-not-fire")

    trigger = await Trigger(
        name="test_disabled",
        trigger_type=TriggerType.SCHEDULE,
        sched_trigger_type="cron",
        expr="* * * * *",
        enabled=False,
        actions=[TriggerAction(
            action_type=ActionType.CALLBACK, callback_name="cb_disabled_check",
        )],
    ).save()

    await _fire_schedule_job(trigger.id)
    assert runs == []
    refreshed = await Trigger.get_by_id(trigger.id)
    assert refreshed.counter == 0


# ── RUN_AGENT: a scheduled agent run ────────────────────────────────────────

@pytest.fixture
def launches(monkeypatch):
    """Capture ``Agent.launch`` (the real one spawns a worker) and the trigger log."""
    import uuid

    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.fs_store.operations import trigger_log

    calls: _Calls = _Calls()
    log: list[dict] = []

    async def _launch(self, prompt, *, deployment=None, wait=False, **options):
        proc = AgenticProcess(id=str(uuid.uuid4()), name=options.get("name") or "scheduled", status="running")
        calls.append({"agent_id": self.id, "prompt": prompt, "options": options, "process": proc, "lifecycle": []})
        return proc

    def _call(process):
        return next(c for c in calls if c["process"] is process)

    async def _wait(self, *a, **kw):
        _call(self)["lifecycle"].append("wait")

    async def _exit(self):
        _call(self)["lifecycle"].append("exit")
        return None

    async def _save(self, *a, **kw):
        _call(self)["lifecycle"].append(f"save:{self.status}")
        return self

    monkeypatch.setattr(Agent, "launch", _launch)
    monkeypatch.setattr(AgenticProcess, "wait", _wait)
    monkeypatch.setattr(AgenticProcess, "exit", _exit)
    monkeypatch.setattr(AgenticProcess, "save", _save)
    monkeypatch.setattr(AgenticProcess, "fetch_worker_status", lambda self: worker_status["value"])
    monkeypatch.setattr(trigger_log, "append_entry", lambda _name, entry: log.append(entry))
    worker_status = {"value": "complete"}
    calls.worker_status = worker_status  # type: ignore[attr-defined]
    return calls, log


class _Calls(list):
    """A list that can also carry the fixture's worker-status knob."""


async def _settle_detached() -> None:
    from flow_sdk.request_context import detached

    await asyncio.gather(*list(detached._DETACHED))


async def _agent(tmp_path, name: str, **fields):
    from tests.unit.agent._seed import seed_agent

    return await seed_agent(tmp_path / name, name, **fields)


@pytest.mark.asyncio
async def test_run_agent_runs_the_parent_agent_with_its_prompt(initialize_test_db, tmp_path, launches) -> None:
    calls, log = launches
    agent = await _agent(tmp_path, "sched-parent")
    trigger = await Trigger(
        name="morning",
        trigger_type=TriggerType.SCHEDULE,
        sched_trigger_type="cron",
        expr="0 9 * * *",
        parent_type_id=str(agent.typeid),
        # Empty target = "my parent", exactly as the indexer leaves it.
        actions=[TriggerAction(action_type=ActionType.RUN_AGENT, prompt="summarize the day")],
    ).save()

    await _fire_schedule_job(trigger.id)

    assert len(calls) == 1
    assert calls[0]["agent_id"] == agent.id
    assert calls[0]["prompt"] == "summarize the day"
    assert calls[0]["options"]["context_data"] == {"trigger_id": trigger.id}
    # The fire's log names the run it started — the handle the UI follows.
    assert log[-1]["agentic_process_id"] == calls[0]["process"].id


@pytest.mark.asyncio
async def test_run_agent_explicit_target_wins_over_parent(initialize_test_db, tmp_path, launches) -> None:
    calls, _ = launches
    parent = await _agent(tmp_path, "sched-owner")
    other = await _agent(tmp_path, "sched-other")
    trigger = await Trigger(
        name="elsewhere", trigger_type=TriggerType.SCHEDULE, sched_trigger_type="cron", expr="0 9 * * *",
        parent_type_id=str(parent.typeid),
        actions=[TriggerAction(action_type=ActionType.RUN_AGENT, target_type_id=str(other.typeid), prompt="p")],
    ).save()

    await _fire_schedule_job(trigger.id)
    assert [c["agent_id"] for c in calls] == [other.id]


@pytest.mark.asyncio
async def test_run_agent_with_no_agent_reports_trigger_failed(initialize_test_db, launches, monkeypatch) -> None:
    from flow_sdk.builtin import trigger_on_tag

    calls, _ = launches
    failures: list[dict] = []
    monkeypatch.setattr(trigger_on_tag, "emit_trigger_failed", lambda *a, **kw: failures.append({"args": a, **kw}))
    trigger = await Trigger(
        name="orphan", trigger_type=TriggerType.SCHEDULE, sched_trigger_type="cron", expr="0 9 * * *",
        actions=[TriggerAction(action_type=ActionType.RUN_AGENT, prompt="p")],
    ).save()

    await _fire_schedule_job(trigger.id)
    assert calls == []
    assert [f["stage"] for f in failures] == ["action"]
    assert failures[0]["action_type"] == "run_agent"


@pytest.mark.asyncio
async def test_run_agent_skips_a_disabled_agent(initialize_test_db, tmp_path, launches) -> None:
    calls, log = launches
    agent = await _agent(tmp_path, "sched-disabled", enabled=False)
    trigger = await Trigger(
        name="off", trigger_type=TriggerType.SCHEDULE, sched_trigger_type="cron", expr="0 9 * * *",
        parent_type_id=str(agent.typeid),
        actions=[TriggerAction(action_type=ActionType.RUN_AGENT, prompt="p")],
    ).save()

    await _fire_schedule_job(trigger.id)
    assert calls == []
    assert log[-1]["agentic_process_id"] is None


# ── one-shot schedules fire once ────────────────────────────────────────────

def test_a_spent_one_shot_is_recognised_and_a_pending_one_is_not() -> None:
    from datetime import datetime, timedelta, timezone

    at = datetime(2026, 9, 14, 12, 0, 0, tzinfo=timezone.utc)
    base = dict(name="once", trigger_type=TriggerType.SCHEDULE, sched_trigger_type="date", expr=at.isoformat())
    assert Trigger(**base)._spent_one_shot() is False, "never fired"
    assert Trigger(**base, last_run=at - timedelta(seconds=5))._spent_one_shot() is False, "fired before this run time"
    assert Trigger(**base, last_run=at + timedelta(milliseconds=3))._spent_one_shot() is True
    cron = {**base, "sched_trigger_type": "cron", "expr": "* * * * *"}
    assert Trigger(**cron, last_run=at)._spent_one_shot() is False, "a cron is never spent"


@pytest.mark.asyncio
async def test_re_arming_a_fired_one_shot_does_not_run_it_again(monkeypatch) -> None:
    """Right after a `date` job fires its run time is still inside the misfire
    grace window, so re-adding it (any re-index re-arms) ran it a second time."""
    from datetime import datetime, timedelta, timezone
    from unittest.mock import MagicMock

    scheduler = MagicMock()
    monkeypatch.setattr("flow_sdk.builtin.trigger._get_scheduler", lambda: scheduler)
    at = datetime.now(timezone.utc) - timedelta(milliseconds=50)
    trigger = Trigger(name="once", trigger_type=TriggerType.SCHEDULE, sched_trigger_type="date",
                      expr=at.isoformat(), last_run=at + timedelta(milliseconds=3))
    trigger.id = "11111111-1111-4111-8111-111111111111"

    await trigger._register_schedule_job()
    scheduler.add_job.assert_not_called()


@pytest.mark.asyncio
async def test_a_scheduled_run_is_supervised_to_its_end(initialize_test_db, tmp_path, launches) -> None:
    """`launch` returns at scheduling time and nothing ever ended the lifecycle,
    so every scheduled run stayed RUNNING in the run history forever."""
    calls, _ = launches
    agent = await _agent(tmp_path, "sched-finish")
    trigger = await Trigger(
        name="finish", trigger_type=TriggerType.SCHEDULE, sched_trigger_type="cron", expr="0 9 * * *",
        parent_type_id=str(agent.typeid),
        actions=[TriggerAction(action_type=ActionType.RUN_AGENT, prompt="p")],
    ).save()

    await _fire_schedule_job(trigger.id)
    await _settle_detached()

    assert calls[0]["lifecycle"] == ["wait", "exit", "save:stopped"]
    assert calls[0]["process"].status == "stopped"


@pytest.mark.asyncio
async def test_a_scheduled_run_whose_worker_errored_ends_failed(initialize_test_db, tmp_path, launches) -> None:
    calls, _ = launches
    calls.worker_status["value"] = "error"
    agent = await _agent(tmp_path, "sched-errored")
    trigger = await Trigger(
        name="errored", trigger_type=TriggerType.SCHEDULE, sched_trigger_type="cron", expr="0 9 * * *",
        parent_type_id=str(agent.typeid),
        actions=[TriggerAction(action_type=ActionType.RUN_AGENT, prompt="p")],
    ).save()

    await _fire_schedule_job(trigger.id)
    await _settle_detached()

    assert calls[0]["process"].status == "failed"


@pytest.mark.asyncio
async def test_a_fire_records_the_schedules_next_run(initialize_test_db, monkeypatch) -> None:
    """The row kept the next_run it was armed with, so after the first fire the
    Schedule tab showed a time already in the past as "next"."""
    from datetime import datetime, timedelta, timezone
    from types import SimpleNamespace
    from unittest.mock import MagicMock

    upcoming = (datetime.now(timezone.utc) + timedelta(minutes=1)).replace(microsecond=0)
    scheduler = MagicMock()
    scheduler.get_job.return_value = SimpleNamespace(next_run_time=upcoming)
    monkeypatch.setattr("flow_sdk.builtin.trigger._get_scheduler", lambda: scheduler)
    trigger = await Trigger(
        name="cron next", trigger_type=TriggerType.SCHEDULE, sched_trigger_type="cron", expr="* * * * *",
    ).save()

    await _fire_schedule_job(trigger.id)
    assert (await Trigger.get_by_id(trigger.id)).next_run == upcoming

    scheduler.get_job.return_value = None  # a fired one-shot's job is gone
    await _fire_schedule_job(trigger.id)
    assert (await Trigger.get_by_id(trigger.id)).next_run is None
