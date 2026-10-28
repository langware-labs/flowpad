"""A cloud deploy (``Agent.deploy_to_cloud``): answered before any step runs, each step a child of the agent's
``deploy`` activity, a refusal told on that activity; no model funding is a warning, never a refusal; one deploy per
agent at a time. The hub is the in-memory double. No network."""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.activity import Activity, ActivityState, monitor
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_cloud_deploy import DEPLOY_ACTIVITY, DeployRunning
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge
from flow_sdk.cloud_client.shared.errors import HubError
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

    final = await deploy_ended(agent, "user-1", "production", provider="e2b")

    readiness_step = next(c for c in final.children if c.name == "readiness")
    assert readiness_step.message == (
        f"No LLM funding for cloud-agent: {EXHAUSTED}: raise the limit (Configure) or wait for it to reset"
    )
    assert final.state == ActivityState.COMPLETED
    assert hub.deploys == [{"environment": "production", "provider": "e2b", "require": []}], "funding never stops it"


async def test_a_deploy_answers_before_any_of_its_steps_runs(agent, hub):
    ended = asyncio.Event()
    stop = monitor.subscribe(lambda root, transition: ended.set() if root.is_terminal else None)

    try:
        accepted = await agent.deploy_to_cloud("user-1", "production", provider="e2b")
        answered = monitor.get(DEPLOY_ACTIVITY, subject_entity=str(agent.typeid))
        await ended.wait()
    finally:
        stop()

    assert accepted == {"activity": {"path": DEPLOY_ACTIVITY, "subject_entity": str(agent.typeid)}}
    assert [(c.name, c.state) for c in answered.children] == [
        (name, ActivityState.PENDING) for name in ("publish", "dependencies", "plan", "readiness", "machine")
    ]
    assert hub.deploys == [{"environment": "production", "provider": "e2b", "require": []}]


async def test_a_step_failing_fails_itself_and_the_deploy_and_the_rest_are_interrupted(agent, hub, monkeypatch):
    async def refused(self, environment=None, *, provider=None, token_allocation=None):
        raise RuntimeError("the hub refused")

    monkeypatch.setattr(Agent, "plan_deployment", refused)

    final = await deploy_ended(agent, "user-1", "production", provider="e2b")

    assert [(c.name, c.state, c.message) for c in final.children] == [
        ("publish", ActivityState.COMPLETED, None),
        ("dependencies", ActivityState.COMPLETED, None),
        ("plan", ActivityState.FAILED, "the hub refused"),
        ("readiness", ActivityState.INTERRUPTED, None),
        ("machine", ActivityState.INTERRUPTED, None),
    ]
    assert final.state == ActivityState.FAILED
    assert hub.deploys == []


DROPPED = "Server disconnected without sending a response."


def _dropped_answer(monkeypatch, hub, agent, *, placed: bool) -> dict:
    """The hub's deploy answer lost on the way (status 0) while the hub pushes the placement over its socket:
    once as it is being worked on, then — when *placed* — with its machine, after the answer was lost. The
    placement's row."""
    planned = hub.deployment(f"agent-{agent.id}", "production")

    def row(seconds: int, **fields) -> dict:
        return {**planned, "updated_date": f"2099-01-01T00:00:{seconds:02d}Z", **fields}

    async def push(pushed: dict) -> None:
        await hub_ws_bridge._handle_deployment_op("update", planned["id"], pushed)

    async def dropped(entity, environment=None, *, provider=None, require=None, deployment_id=None):
        await push(row(1))
        if placed:
            machine = {"kind": "e2b", "provider": "e2b", "external_id": "compute_node-box"}
            later.append(asyncio.create_task(push(row(2, origin=machine, status={"provider_state": "running"}))))
        raise HubError(0, DROPPED)

    later: list[asyncio.Task] = []
    monkeypatch.setattr("flow_sdk.builtin.cloud_deploy.deploy_entity_to_cloud", dropped)
    monkeypatch.setattr("flow_sdk.builtin.cloud_deploy.PLACED_LOCAL_POLL_S", 0)
    return planned


async def test_a_dropped_hub_answer_is_not_a_failure_the_machine_pushed_over_the_socket_is(agent, hub, monkeypatch):
    planned = _dropped_answer(monkeypatch, hub, agent, placed=True)

    final = await deploy_ended(agent, "user-1", "production", provider="e2b")

    assert final.state == ActivityState.COMPLETED
    mirrored = await Deployment.get_by_id(planned["id"])
    assert mirrored.origin.external_id == "compute_node-box" and mirrored.status.provider_state == "running"


async def test_a_dropped_hub_answer_with_no_machine_pushed_in_time_fails_the_deploy(agent, hub, monkeypatch):
    _dropped_answer(monkeypatch, hub, agent, placed=False)
    monkeypatch.setattr("flow_sdk.builtin.cloud_deploy.PLACED_WITHIN_S", 0)

    final = await deploy_ended(agent, "user-1", "production", provider="e2b")

    machine = next(c for c in final.children if c.name == "machine")
    assert machine.state == ActivityState.FAILED and "sent no machine" in machine.message
    assert final.state == ActivityState.FAILED


async def test_a_second_deploy_of_the_same_agent_is_refused_while_one_runs(agent, hub):
    Activity.try_claim(DEPLOY_ACTIVITY, subject_entity=str(agent.typeid))

    with pytest.raises(DeployRunning):
        await agent.deploy_to_cloud("user-1", "production", provider="e2b")
    assert hub.deploys == []
