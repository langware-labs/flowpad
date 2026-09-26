"""Chief of Staff, end to end on MockWorker — the real app, serve loop, ledger, dispatcher, delivery
and Tasks channel; only the model is mocked (``tests/utils/mock_worker.py``, behaviors in
``mock_behaviors.py``). The matrix: every worker vendor × Chief of Staff on / off.

The person talks to the agent on a real channel (the Telegram driver over its loopback Double); the
agent's staff report on its Tasks channel; what the person hears is what the Double's bot API sent.
The mock Chief of Staff acts as one only when its instructions — as its vendor's driver projected
them — carry CoS.md, so the checkbox's gating is proven by what the worker actually receives.

Why these are ``long`` (measured 2026-09-22, timeline per step): nothing waits on a clock — the
drain wakes on arrivals, the mock settles at 0 s — the cost is the work. A Chief-of-Staff cell is
~10 headless worker turns and ~15 messages through the full chain (Telegram poll or bus event →
ingest → projection → serve loop → turn → ledger write → reply send → its recorded copy), at
20–100 ms a step on the real SQLite store. The teardown ends the serve loop between cycles
(``stop_serving``), so no write is cut in half.
"""
from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import SourceStatus
from flow_sdk.builtin.task import Task
from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, load_module
from flow_sdk.ingest.poller import poll_source
from flow_sdk.ingest.sync import sync_source
from flow_sdk.ingest.testing import make_data_source
from flow_sdk.tasks import dispatch, ledger, runtime
from flow_sdk.tasks.cos import COS_MARKER, sync_tasks_channel
from tests.utils.mock_behaviors import both, chief_of_staff, flow_runner, task_owner
from tests.utils.mock_worker import MOCK_VENDORS, mock_driver_for

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

#: How long one step of a flow may take on MockWorker — a data-path budget, not a model's.
STEP_BUDGET_S = 8.0
SPAWNING = {"claude"}


class Rig:
    """One agent, its person channel (Telegram Double), its Tasks channel, the serve loop, the mock driver."""

    def __init__(self, agent, telegram, tasks, double, driver):
        self.agent, self.telegram, self.tasks, self.double, self.driver = agent, telegram, tasks, double, driver
        #: How much the person had heard when they last spoke — replies are read from here on.
        self.since = 0

    async def say(self, text: str) -> None:
        """The person writes on Telegram; the backend polls it in, as it does."""
        self.since = len(self.double.sent())
        self.double.deliver(text, sender=self.double.sender)
        # Through the poller's in-flight guard, as every out-of-band poll goes: the serve loop polls this
        # source too, and two unguarded syncs of one source ingest the same update twice.
        await poll_source(self.telegram)

    def heard(self) -> list[str]:
        """What the person has been sent, oldest first."""
        return [str(m.get("text") or "") for m in self.double.sent()]

    async def hears(self, prefix: str) -> str:
        """Wait for the person to be sent a message starting with ``prefix``; answers it."""
        deadline = time.monotonic() + STEP_BUDGET_S
        while time.monotonic() < deadline:
            await runtime.settle()
            for said in self.heard()[self.since:]:
                if said.startswith(prefix):
                    return said
            await asyncio.sleep(0.02)
        raise AssertionError(f"the person never heard {prefix!r}\nheard: {self.heard()}\ntasks: {await self.tasks_status()}")

    async def delegated(self) -> list:
        return sorted([t for t in await Task.get_all() or [] if t.creator == f"agent:{self.agent.id}"], key=lambda t: str(t.created_date))

    async def tasks_status(self) -> list:
        return [(t.title, t.status) for t in await self.delegated()]

    async def settled_task(self, status: str):
        deadline = time.monotonic() + STEP_BUDGET_S
        while time.monotonic() < deadline:
            await runtime.settle()
            done = [t for t in await self.delegated() if t.status == status]
            if done:
                return done[-1]
            await asyncio.sleep(0.02)
        raise AssertionError(f"no task reached {status}: {await self.tasks_status()}")


@pytest.fixture
async def project(tmp_path, bootstrapped_client):
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    root = tmp_path / "proj"
    root.mkdir()
    return await Project(id=mint_uuid(), name=f"cos-{mint_uuid()[:8]}", fs_storage_mount_path=str(root)).save()


@contextlib.asynccontextmanager
async def rig(vendor: str, *, cos: bool, behavior, project, client, monkeypatch, tmp_path, **agent_fields):
    from flow_sdk.builtin.agent_serve import hold_positions, serve, stop_serving  # noqa: PLC0415
    from flow_sdk.stream_inbox import outbound  # noqa: PLC0415

    driver = mock_driver_for(vendor, tmp_path / "transcripts", behavior=behavior, flow=flow_runner(client, monkeypatch))
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: driver)
    runtime.start(watchdog=False)
    with load_module(SHIPPED_ROOT / "telegram" / "tests", "matrix").Double() as double:
        agent = Agent(name=f"Dana {uuid.uuid4().hex[:6]}", worker_type=vendor, system_prompt="You are Dana.",
                      chief_of_staff=cos, project_id=project.id, **agent_fields)
        await agent.save()
        monkeypatch.setattr(DataDriver.loaded("telegram"), "credentials_for", double.credentials)
        telegram = make_data_source("telegram", name=f"dana telegram {uuid.uuid4().hex[:6]}", config=dict(double.config),
                                    owner=agent.typeid, status=SourceStatus.ACTIVE.value,
                                    allowed_senders=[double.sender], **dict(double.fields))
        await telegram.save()
        await sync_source(telegram)
        tasks = await sync_tasks_channel(agent)
        deployment = await agent.local_deployment()
        sources = [telegram, *([tasks] if tasks is not None else [])]
        await hold_positions(deployment, sources)
        loop = asyncio.get_running_loop().create_task(serve(agent, deployment, sources=sources))
        try:
            yield Rig(agent, telegram, tasks, double, driver)
        finally:
            # Quiesce before stopping: work in flight finishes on its own session, not mid-write — the
            # task runtime, the replies still sending (whose recorded copies wake the drain once more),
            # then the serve loop, ended between cycles.
            await runtime.settle()
            runtime.stop()
            await outbound.settle()
            await stop_serving(loop)
            for source in sources:
                await source.delete()
            await agent.delete()


def _staff():
    return both(chief_of_staff(), task_owner(result="3 themes, summary.md written"))


@pytest.mark.long  # cos-on 2.4–3.2s (~10 turns, ~15 messages), cos-off 1.0–1.3s (3 turns)
@pytest.mark.parametrize("cos", [True, False], ids=["cos-on", "cos-off"])
@pytest.mark.parametrize("vendor", MOCK_VENDORS)
async def test_every_worker_with_and_without_chief_of_staff(vendor, cos, project, bootstrapped_client, monkeypatch, tmp_path):
    async with rig(vendor, cos=cos, behavior=_staff(), project=project, client=bootstrapped_client, monkeypatch=monkeypatch, tmp_path=tmp_path) as r:
        # A — a quick question is answered at once, by the chief itself.
        await r.say("[quick] What is six times seven?")
        await r.hears("Quick answer: 42." if cos else "Plain answer: [quick]")

        # B — a short job: a native subagent on a harness that spawns one, a task on one that cannot.
        await r.say("[short] Look up the release codename")
        if not cos:
            await r.hears("Plain answer: [short]")
        elif vendor in SPAWNING:
            await r.hears("Checked: It is 17.")
            spawn = [e for t in r.driver.turns for e in t.entries if e["message"]["content"][0].get("name") == "Agent"]
            assert spawn and spawn[0]["message"]["content"][0]["input"]["subagent_type"] == "general-worker"
        else:
            await r.hears("Started task")
            await r.hears("Done: 3 themes")

        # C — a long job becomes a task its subagent finishes, and the person hears the result.
        await r.say("[long] Summarise the Q3 notes into summary.md")
        if not cos:
            await r.hears("Plain answer: [long]")
            assert await r.delegated() == [], "an agent without Chief of Staff delegates nothing"
            assert r.tasks is None and all(COS_MARKER not in t.instructions for t in r.driver.turns)
            return
        await r.hears("Started task")
        await r.hears("Done: 3 themes")
        task = (await r.delegated())[-1]
        assert task.status == "done" and task.owner == "subagent:general-worker" and task.origin_conversation
        log = [(c.data["task_event"], c.data["author"]) for c in await ledger.comments(task)]
        assert [e for e, _ in log] == ["created", "started", "note", "done"], log
        assert log[0][1] == f"agent:{r.agent.id}" and log[1][1] == "subagent:general-worker"

        # What each worker received: the chief its vendor's projection WITH CoS.md (and, only where the
        # harness spawns, a native roster); every run its staff prompt WITHOUT it.
        chief_turns = [t for t in r.driver.turns if not t.owned_task_id]
        run_turns = [t for t in r.driver.turns if t.owned_task_id]
        assert chief_turns and all(t.is_chief_of_staff for t in chief_turns)
        assert "task-management" in chief_turns[0].instructions and "subagent:general-worker" in chief_turns[0].instructions
        assert bool(chief_turns[0].agents) == (vendor in SPAWNING)
        assert run_turns and not any(t.is_chief_of_staff for t in run_turns)
        assert "You own task" in run_turns[0].instructions and "# General worker" in run_turns[0].instructions

        # Runtime state never touches git: whatever landed under the project is authored configuration
        # (the agent's card, its channels) — no task, no run, no comment.
        written = sorted(str(p.relative_to(project.fs_storage_mount_path)) for p in
                         Path(project.fs_storage_mount_path).rglob("*") if p.is_file())
        assert not [f for f in written if "/task/" in f or "task.md" in f or "/work/" in f], written
        assert task.placement == "instance" and not task.asset_ref


@pytest.mark.long  # 2.2–2.5s: 5 turns, 7 messages
@pytest.mark.parametrize("vendor", ["claude", "codex"])
async def test_a_question_from_the_staff_goes_to_the_person_and_the_answer_comes_back(vendor, project, bootstrapped_client, monkeypatch, tmp_path):
    behavior = both(chief_of_staff(), task_owner(ask="Fiscal or calendar Q3?", result="Summary written"))
    async with rig(vendor, cos=True, behavior=behavior, project=project, client=bootstrapped_client, monkeypatch=monkeypatch, tmp_path=tmp_path) as r:
        await r.say("[long] Summarise the Q3 notes")
        await r.hears("Started task")
        await r.hears("A question from the team: Fiscal or calendar Q3?")
        assert (await r.delegated())[-1].status == "input_required"
        await r.say("[answer] Calendar")
        said = await r.hears("Done: Summary written")
        assert "Calendar" in said, "the person's answer reached the subagent that asked"
        task = (await r.delegated())[-1]
        events = [c.data["task_event"] for c in await ledger.comments(task)]
        assert events == ["created", "started", "note", "asked", "replied", "done"], events


@pytest.mark.long  # 2.0s: 5 turns, two tasks
async def test_the_staff_is_capped_per_chief_and_the_next_task_waits_its_turn(project, bootstrapped_client, monkeypatch, tmp_path):
    monkeypatch.setattr(dispatch, "MAX_RUNS", 1)
    gate = asyncio.Event()

    async def slow_owner(turn):
        if not turn.owned_task_id:
            return await chief_of_staff()(turn)
        await turn.flow("task", "start", turn.owned_task_id)
        await gate.wait()
        await turn.flow("task", "done", turn.owned_task_id, "--result", f"finished {turn.owned_task_id[:4]}")
        return "done"

    async with rig("claude", cos=True, behavior=slow_owner, project=project, client=bootstrapped_client, monkeypatch=monkeypatch, tmp_path=tmp_path) as r:
        await r.say("[long] First job")
        await r.hears("Started task")
        first = await r.settled_task("working")
        await r.say("[long] Second job")
        deadline = time.monotonic() + STEP_BUDGET_S
        while len(await r.delegated()) < 2 and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
        second = [t for t in await r.delegated() if t.id != first.id][0]
        await runtime.settle()
        assert (await Task.get_by_id(second.id)).status == "submitted" and not (await Task.get_by_id(second.id)).process_id
        gate.set()
        await r.hears("Done: finished")
        deadline = time.monotonic() + STEP_BUDGET_S
        while time.monotonic() < deadline and (await Task.get_by_id(second.id)).status != "done":
            await runtime.settle()
            await asyncio.sleep(0.02)
        assert (await Task.get_by_id(second.id)).status == "done", "the waiting task ran once capacity freed"


@pytest.mark.long  # 2.4–2.9s: 5 turns, 7 messages
async def test_a_run_past_its_turn_budget_fails_and_the_person_is_told(project, bootstrapped_client, monkeypatch, tmp_path):
    behavior = both(chief_of_staff(), task_owner(ask="Which quarter?"))
    async with rig("claude", cos=True, behavior=behavior, project=project, client=bootstrapped_client, monkeypatch=monkeypatch, tmp_path=tmp_path) as r:
        await r.say("[long] Summarise the notes")
        await r.hears("Started task")
        await r.hears("A question from the team")
        task = (await r.delegated())[-1]
        task.budget_turns = 1
        await task.save()
        await r.say("[answer] Calendar")
        await r.hears("Heads-up: the task failed.")
        failed = await Task.get_by_id(task.id)
        assert failed.status == "failed" and "turn budget" in [c.data["text"] for c in await ledger.comments(failed)][-1]


@pytest.mark.long  # 1.3s: 3 turns
async def test_a_quiet_working_task_is_announced_stalled_once_and_wakes_its_chief(project, bootstrapped_client, monkeypatch, tmp_path):
    async def silent_owner(turn):
        if not turn.owned_task_id:
            return await chief_of_staff()(turn)
        await turn.flow("task", "start", turn.owned_task_id)
        return "working quietly"

    async with rig("claude", cos=True, behavior=silent_owner, project=project, client=bootstrapped_client, monkeypatch=monkeypatch, tmp_path=tmp_path) as r:
        await r.say("[long] Something slow")
        await r.hears("Started task")
        task = await r.settled_task("working")
        later = datetime.now(timezone.utc) + timedelta(seconds=dispatch.STALL_AFTER_S + 5)
        assert await dispatch.check_stalls(later) == [task.id]
        assert await dispatch.check_stalls(later) == [], "announced once per quiet spell"
        await r.hears("Heads-up: the task stalled.")
