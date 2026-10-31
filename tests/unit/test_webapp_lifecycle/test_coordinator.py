"""The coordinator: one run per app, a bounded ladder per fingerprint, the record as the only state."""

import asyncio
from types import SimpleNamespace

import pytest

from flow_sdk.builtin import webapp_setup
from flow_sdk.core.webapp import coordinator, handling, readiness, record
from flow_sdk.core.webapp.failure import make
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue
from flow_sdk.schema.data_spec.webapp_lifecycle_spec import (
    FailureCode,
    FailurePhase,
    HandlingAction,
    LifecycleState,
    WebappHandlingSpec,
)

pytestmark = pytest.mark.asyncio


@pytest.fixture
def world(tmp_path, monkeypatch):
    folder = tmp_path / "shop"
    folder.mkdir()
    app = SimpleNamespace(id="a1", project_id="p1", asset_ref=str(folder), name="shop", typeid="micro_app-a1")
    state = SimpleNamespace(app=app, outcomes=[], ups=0, stops=0, fixer=0, setups=[], runs=0)

    async def find(_key):
        return app

    async def step(webapp_id, which, *, check, display=""):
        assert which == webapp_setup.UP
        if check:
            return ReturnedValue(exit_code=ExitCode.OK, detail="up", ran=False)
        state.ups += 1
        outcome = state.outcomes.pop(0) if state.outcomes else None
        if outcome is None:
            return ReturnedValue(exit_code=ExitCode.OK, detail="up", value="5000")
        failure = make(FailurePhase.START, outcome, f"{outcome.value} happened")
        await record.set_state(webapp_id, LifecycleState.FAILED, failure.raw, failure=failure)
        return ReturnedValue(exit_code=ExitCode.NOT_YET, detail=failure.raw, value=failure.model_dump(mode="json"))

    async def record_up(webapp_id, _app, project_id, _answer):
        await record.set_state(webapp_id, LifecycleState.UP, "up", project_id=project_id, failure=None)

    async def stop(_key):
        state.stops += 1
        return ReturnedValue(exit_code=ExitCode.OK, detail="stopped")

    async def fixer(_key, _request):
        state.fixer += 1

    async def owed(_app, *, display):
        return None

    async def setup_node(_app, node):
        state.setups.append(node)
        return None

    async def quick(_app, rec):
        return rec.state is LifecycleState.UP

    monkeypatch.setattr(coordinator, "_app", find)
    monkeypatch.setattr(webapp_setup, "step", step)
    monkeypatch.setattr(webapp_setup, "_record_up", record_up)
    monkeypatch.setattr(webapp_setup, "_processes", lambda _app: [object()])
    monkeypatch.setattr(webapp_setup, "stop", stop)
    monkeypatch.setattr(coordinator, "_run_fixer", fixer)
    monkeypatch.setattr(coordinator, "_setup_owed", owed)
    monkeypatch.setattr(coordinator, "_setup_node", setup_node)
    monkeypatch.setattr(readiness, "quick", quick)
    coordinator._TASKS.clear()
    return state


async def test_an_app_comes_up_and_a_warm_open_does_nothing(world):
    rec = await coordinator.bring_up(world.app, wait=True)
    assert rec.state is LifecycleState.UP and world.ups == 1
    again = await coordinator.bring_up(world.app)
    assert again.state is LifecycleState.UP and world.ups == 1, "a warm open starts no run"


async def test_two_opens_at_once_are_one_run(world):
    world.outcomes = [None]
    await asyncio.gather(coordinator.bring_up(world.app, wait=True), coordinator.bring_up(world.app, wait=True))
    assert world.ups == 1


async def test_a_crash_is_restarted_by_code_once_and_no_agent_runs(world):
    world.outcomes = [FailureCode.EXITED]  # then up
    rec = await coordinator.bring_up(world.app, wait=True)
    assert rec.state is LifecycleState.UP and world.stops == 1 and world.fixer == 0
    (counter,) = rec.attempts
    assert counter.deterministic == 1 and counter.agent == 0


async def test_an_unknown_failure_gets_the_agent_once_then_a_person(world):
    world.outcomes = [FailureCode.UNKNOWN, FailureCode.UNKNOWN]
    rec = await coordinator.bring_up(world.app, wait=True)
    assert world.fixer == 1 and rec.state is LifecycleState.NEEDS_PERSON
    world.outcomes = [FailureCode.UNKNOWN]
    rec = await coordinator.bring_up(world.app, wait=True)
    assert world.fixer == 1, "the same failure inside the cooldown never reaches the agent again"
    assert rec.state is LifecycleState.NEEDS_PERSON


async def test_a_persons_fix_may_run_the_agent_again(world):
    world.outcomes = [FailureCode.UNKNOWN, FailureCode.UNKNOWN]
    await coordinator.bring_up(world.app, wait=True)
    world.outcomes = [FailureCode.UNKNOWN, None]
    rec = await coordinator.bring_up(world.app, reason="fix", wait=True)
    assert world.fixer == 2 and rec.state is LifecycleState.UP


async def test_a_learned_handling_is_run_by_code_and_counted(world):
    failure = make(FailurePhase.START, FailureCode.UNKNOWN, "unknown happened")
    handling.add(world.app.asset_ref, WebappHandlingSpec(id="dep", action=HandlingAction.SETUP,
                                                          arg="asset_setup:tenant"), proof=failure)
    world.outcomes = [FailureCode.UNKNOWN]
    rec = await coordinator.bring_up(world.app, wait=True)
    assert rec.state is LifecycleState.UP and world.setups == ["asset_setup:tenant"] and world.fixer == 0
    (h,) = handling.load(world.app.asset_ref)
    assert h.fixed == 1


async def test_a_handling_that_says_needs_person_stops_there(world):
    failure = make(FailurePhase.START, FailureCode.UNKNOWN, "unknown happened")
    handling.add(world.app.asset_ref, WebappHandlingSpec(id="human", action=HandlingAction.NEEDS_PERSON,
                                                          arg="launch the tenant from Admin"), proof=failure)
    world.outcomes = [FailureCode.UNKNOWN]
    rec = await coordinator.bring_up(world.app, wait=True)
    assert rec.state is LifecycleState.NEEDS_PERSON and rec.detail.startswith("launch the tenant") and world.fixer == 0


async def test_a_page_error_a_handling_ignores_leaves_it_up(world):
    await coordinator.bring_up(world.app, wait=True)
    answer = await coordinator.report_page(world.app, [{"source": "console", "text": "Warning: key prop"}])
    assert answer["usable"] and record.read("a1").state is LifecycleState.UP


async def test_an_unknown_page_error_degrades_and_recovers_on_the_backend(world):
    await coordinator.bring_up(world.app, wait=True)
    answer = await coordinator.report_page(world.app, [{"source": "page", "text": "TypeError: boom"}])
    assert not answer["usable"] and answer["recovering"]
    await asyncio.gather(coordinator._TASKS["a1"], return_exceptions=True)
    assert world.fixer == 1 and record.read("a1").state is LifecycleState.UP


async def test_a_bad_handlings_file_is_said_to_the_person(world):
    (handling.setup_dir(world.app.asset_ref)).mkdir(parents=True, exist_ok=True)
    handling.file_of(world.app.asset_ref).write_text("{not json")
    world.outcomes = [FailureCode.UNKNOWN]
    rec = await coordinator.bring_up(world.app, wait=True)
    assert rec.state is LifecycleState.NEEDS_PERSON and rec.failure.code is FailureCode.BAD_HANDLINGS
    assert world.fixer == 0


async def test_a_port_another_program_holds_is_the_persons_never_an_agents(world):
    world.outcomes = [FailureCode.PORT_HELD]
    rec = await coordinator.bring_up(world.app, wait=True)
    assert rec.state is LifecycleState.NEEDS_PERSON and world.fixer == 0 and world.stops == 0


async def test_a_missing_credential_is_the_persons_never_an_agents(world, monkeypatch):
    from flow_sdk.core.webapp.failure import make as typed

    async def owed(_app, *, display):
        return typed(FailurePhase.DEPENDENCY, FailureCode.CREDENTIAL_MISSING, "Google Cloud: not signed in")

    monkeypatch.setattr(coordinator, "_setup_owed", owed)
    rec = await coordinator.bring_up(world.app, wait=True)
    assert rec.state is LifecycleState.NEEDS_PERSON and "Google Cloud" in rec.detail and world.fixer == 0
