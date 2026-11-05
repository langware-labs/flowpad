"""A cloud deploy (``agent_cloud_deploy.run_deployment_steps``): answered before any step runs, each step a child of the agent's
``deploy`` activity, a refusal told on that activity; no model funding is a warning, never a refusal; one deploy per
agent at a time. The hub is the in-memory double. No network."""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.activity import Activity, ActivityState, monitor
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_cloud_deploy import DEPLOY_ACTIVITY, DeployRunning, run_deployment_steps
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.schema.data_spec.activity_spec import ActivityProgressSpec
from tests.utils import fake_hub_store
from tests.utils.deploy_run import deploy_ended

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

EXHAUSTED = "limit 'cost_usd_total' exceeded on endpoint my default"


@pytest.fixture
def hub(monkeypatch):
    return fake_hub_store.install(monkeypatch)


@pytest.fixture(autouse=True)
def _clean_monitor():
    monitor.clear()
    yield
    monitor.clear()


@pytest.fixture
async def agent(home, project, hub, monkeypatch) -> Agent:
    monkeypatch.setattr(Agent, "ensure_on_hub", _published)  # publishing is the git path's; not under test here
    agent = Agent(name="cloud-agent", project_id=str(project.id))
    await agent.save()
    return agent


async def _published(self, actor, force=False):
    return False


async def test_an_unfunded_deploy_is_placed_and_the_readiness_step_says_so(agent, hub):
    planned = await agent.plan_deployment("production", provider="e2b")
    hub.funding[str(planned.id)] = {"kind": "default", "name": "my default", "exhausted": EXHAUSTED}

    final = await deploy_ended(agent, "user-1", "production", provider="e2b", deployment_id=str(planned.id))

    readiness_step = next(c for c in final.children if c.name == "readiness")
    assert readiness_step.message == (
        f"No LLM funding for cloud-agent: {EXHAUSTED}: raise the limit (Configure) or wait for it to reset"
    )
    assert final.state == ActivityState.COMPLETED
    assert hub.deploys == [{"environment": "production", "provider": "e2b", "require": []}], "funding never stops it"


async def test_a_deploy_answers_once_ready_and_before_its_machine_starts(agent, hub):
    ended = asyncio.Event()
    stop = monitor.subscribe(lambda root, transition: ended.set() if root.is_terminal else None)

    try:
        accepted = await run_deployment_steps(agent, "user-1", "production", provider="e2b")
        answered = monitor.get(DEPLOY_ACTIVITY, subject_entity=str(agent.typeid))
        await ended.wait()
    finally:
        stop()

    (planned,) = hub.planned(str(agent.typeid), "production")
    assert accepted == {
        "activity": {"path": DEPLOY_ACTIVITY, "subject_entity": str(agent.typeid)},
        "deployment_id": planned["id"],
    }
    assert [(c.name, c.state) for c in answered.children] == [
        ("publish", ActivityState.COMPLETED),
        ("dependencies", ActivityState.COMPLETED),
        ("plan", ActivityState.COMPLETED),
        ("values", ActivityState.COMPLETED),
        ("readiness", ActivityState.COMPLETED),
        ("machine", ActivityState.PENDING),
    ]
    assert hub.deploys == [{"environment": "production", "provider": "e2b", "require": []}]


async def test_a_step_refused_before_the_answer_is_the_answer_and_ends_the_deploy(agent, hub, monkeypatch):
    async def refused(self, environment=None, *, provider=None, token_allocation=None, deployment_id=None):
        raise RuntimeError("the hub refused")

    monkeypatch.setattr(Agent, "plan_deployment", refused)
    ended: list[ActivityProgressSpec] = []
    stop = monitor.subscribe(lambda root, transition: ended.append(root.spec()) if root.is_terminal else None)

    try:
        with pytest.raises(RuntimeError, match="the hub refused"):
            await run_deployment_steps(agent, "user-1", "production", provider="e2b")
    finally:
        stop()

    final = ended[-1]
    assert [(c.name, c.state, c.message) for c in final.children] == [
        ("publish", ActivityState.COMPLETED, None),
        ("dependencies", ActivityState.COMPLETED, None),
        ("plan", ActivityState.FAILED, "the hub refused"),
        ("values", ActivityState.INTERRUPTED, None),
        ("readiness", ActivityState.INTERRUPTED, None),
        ("machine", ActivityState.INTERRUPTED, None),
    ]
    assert final.state == ActivityState.FAILED
    assert hub.deploys == []


async def test_the_machine_failing_after_the_answer_is_told_only_on_the_activity(agent, hub, monkeypatch):
    async def refused(entity, environment=None, *, provider=None, require=None, deployment_id=None, machine_size=None):
        raise HubError(500, "the provider is out of machines")

    monkeypatch.setattr("flow_sdk.builtin.cloud_deploy.deploy_entity_to_cloud", refused)

    final = await deploy_ended(agent, "user-1", "production", provider="e2b")

    assert [(c.name, c.state) for c in final.children][-2:] == [
        ("readiness", ActivityState.COMPLETED),
        ("machine", ActivityState.FAILED),
    ]
    assert final.state == ActivityState.FAILED


DROPPED = "Server disconnected without sending a response."


def _dropped_answer(monkeypatch, hub, *, placed: bool) -> None:
    """The hub's deploy answer lost on the way (status 0) while the hub pushes the placement the deploy names
    over its socket: once as it is being worked on, then — when *placed* — with its machine, after the answer
    was lost."""

    async def push(planned: dict, seconds: int, **fields) -> None:
        pushed = {**planned, "updated_date": f"2099-01-01T00:00:{seconds:02d}Z", **fields}
        await hub_ws_bridge._handle_deployment_op("update", planned["id"], pushed)

    async def dropped(entity, environment=None, *, provider=None, require=None, deployment_id=None, machine_size=None):
        planned = hub.rows[deployment_id]  # the row its plan made
        await push(planned, 1)
        if placed:
            machine = {"kind": "e2b", "provider": "e2b", "external_id": "compute_node-box"}
            later.append(asyncio.create_task(push(planned, 2, origin=machine, status={"provider_state": "running"})))
        raise HubError(0, DROPPED)

    later: list[asyncio.Task] = []
    monkeypatch.setattr("flow_sdk.builtin.cloud_deploy.deploy_entity_to_cloud", dropped)


async def test_a_dropped_hub_answer_is_not_a_failure_the_machine_pushed_over_the_socket_is(agent, hub, monkeypatch):
    _dropped_answer(monkeypatch, hub, placed=True)

    final = await deploy_ended(agent, "user-1", "production", provider="e2b")

    assert final.state == ActivityState.COMPLETED
    (planned,) = hub.planned(str(agent.typeid), "production")
    mirrored = await Deployment.get_by_id(planned["id"])
    assert mirrored.origin.external_id == "compute_node-box" and mirrored.status.provider_state == "running"


async def test_a_dropped_hub_answer_with_no_machine_pushed_in_time_fails_the_deploy(agent, hub, monkeypatch):
    _dropped_answer(monkeypatch, hub, placed=False)
    monkeypatch.setattr("flow_sdk.builtin.cloud_deploy.PLACED_WITHIN_S", 0)

    final = await deploy_ended(agent, "user-1", "production", provider="e2b")

    machine = next(c for c in final.children if c.name == "machine")
    assert machine.state == ActivityState.FAILED and "sent no machine" in machine.message
    assert final.state == ActivityState.FAILED


async def test_a_second_deploy_of_the_same_agent_is_refused_while_one_runs(agent, hub):
    Activity.try_claim(DEPLOY_ACTIVITY, subject_entity=str(agent.typeid))

    with pytest.raises(DeployRunning):
        await run_deployment_steps(agent, "user-1", "production", provider="e2b")
    assert hub.deploys == []
