"""A cloud deploy taken on (``agent_cloud_deploy.run_cloud_deploy``): answered before any step runs, each step a
child of the agent's ``deploy`` activity, a refusal told on that activity; no model funding is a warning, never a
refusal; one deploy per agent at a time. The hub is the in-memory double. No network."""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.activity import Activity, ActivityState, monitor
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_cloud_deploy import DEPLOY_ACTIVITY, CloudDeploy, DeployRunning, run_cloud_deploy
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.schema.data_spec.activity_spec import ActivityProgressSpec
from tests.utils import fake_hub_store

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


async def test_an_unfunded_deploy_is_placed_with_a_warning(agent, hub):
    planned = await agent.plan_deployment("production", provider="e2b")
    hub.funding[str(planned.id)] = {"kind": "default", "name": "my default", "exhausted": EXHAUSTED}
    deploy = CloudDeploy(agent, "user-1", "production", provider="e2b")

    await run_cloud_deploy(deploy, background=False)

    assert deploy.warnings == [
        f"No LLM funding for cloud-agent: {EXHAUSTED}: raise the limit (Configure) or wait for it to reset"
    ]
    assert hub.deploys == [{"environment": "production", "provider": "e2b", "require": []}], "funding never stops it"


async def test_a_background_deploy_answers_before_any_of_its_steps_runs(agent, hub):
    ended: list[ActivityProgressSpec] = []
    stop = monitor.subscribe(lambda root, transition: ended.append(root.spec()) if root.is_terminal else None)

    try:
        accepted = await run_cloud_deploy(CloudDeploy(agent, "user-1", "production", provider="e2b"), background=True)
        answered = monitor.get(DEPLOY_ACTIVITY, subject_entity=str(agent.typeid))
        while not ended:
            await asyncio.sleep(0)
    finally:
        stop()

    assert accepted == {
        "agent_id": str(agent.id),
        "activity": {"path": DEPLOY_ACTIVITY, "subject_entity": str(agent.typeid)},
    }
    assert [(c.name, c.state) for c in answered.children] == [
        (name, ActivityState.PENDING) for name in ("publish", "dependencies", "plan", "readiness", "machine")
    ]
    assert ended[-1].state == ActivityState.COMPLETED
    assert hub.deploys == [{"environment": "production", "provider": "e2b", "require": []}]


async def test_a_step_failing_after_the_answer_fails_itself_and_the_deploy_and_the_rest_are_interrupted(
    agent, hub, monkeypatch
):
    async def refused(self, environment=None, *, provider=None, token_allocation=None):
        raise RuntimeError("the hub refused")

    monkeypatch.setattr(Agent, "plan_deployment", refused)
    # A root that ends leaves the monitor: its last tree is the one handed to subscribers as it ends.
    ended: list[ActivityProgressSpec] = []
    stop = monitor.subscribe(lambda root, transition: ended.append(root.spec()) if root.is_terminal else None)

    try:
        # Answered: the refusal comes after the answer, and only the activity is told.
        await run_cloud_deploy(CloudDeploy(agent, "user-1", "production", provider="e2b"), background=True)
        while not ended:
            await asyncio.sleep(0)
    finally:
        stop()

    root = ended[-1]
    assert [(c.name, c.state, c.message) for c in root.children] == [
        ("publish", ActivityState.COMPLETED, None),
        ("dependencies", ActivityState.COMPLETED, None),
        ("plan", ActivityState.FAILED, "the hub refused"),
        ("readiness", ActivityState.INTERRUPTED, None),
        ("machine", ActivityState.INTERRUPTED, None),
    ]
    assert root.state == ActivityState.FAILED
    assert hub.deploys == []


DROPPED = "Server disconnected without sending a response."


def _dropped_answer(monkeypatch, hub, agent, *, placed_on_read: int) -> list[str]:
    """The hub's deploy answer lost on the way (status 0), and its placement row read back: without a machine
    until the *placed_on_read*-th read (0: never). Answers the ids asked for."""

    async def dropped(entity, environment=None, *, provider=None, require=None):
        raise HubError(0, DROPPED)

    asked: list[str] = []
    hub_get = hub.get

    async def get(etype, eid=None, action=None, sub_path=None, **kwargs):
        if str(etype) != "deployment" or action is not None:
            return await hub_get(etype, eid, action, sub_path, **kwargs)
        asked.append(eid)
        row = hub.deployment(str(agent.typeid), "production")
        if placed_on_read and len(asked) >= placed_on_read:
            row |= {
                "origin": {"kind": "e2b", "provider": "e2b", "external_id": "compute_node-box"},
                "status": {"sync_state": "current", "provider_state": "running"},
            }
        return row

    monkeypatch.setattr("flow_sdk.builtin.cloud_deploy.deploy_entity_to_cloud", dropped)
    monkeypatch.setattr("flow_sdk.builtin.cloud_deploy.PLACED_POLL_S", 0)
    monkeypatch.setattr(hub, "get", get)
    return asked


async def test_a_dropped_hub_answer_is_not_a_failure_the_placement_given_its_machine_is(agent, hub, monkeypatch):
    asked = _dropped_answer(monkeypatch, hub, agent, placed_on_read=2)
    deploy = CloudDeploy(agent, "user-1", "production", provider="e2b")

    await run_cloud_deploy(deploy, background=False)

    planned = str(deploy.deployment.id)
    assert asked == [planned, planned], "read until the hub has given it a machine"
    assert deploy.result["deployment"]["origin"]["external_id"] == "compute_node-box"
    adopted = await Deployment.get_by_id(planned)
    assert adopted.origin.external_id == "compute_node-box" and adopted.status.provider_state == "running"


async def test_a_dropped_hub_answer_with_no_machine_in_time_fails_the_deploy(agent, hub, monkeypatch):
    _dropped_answer(monkeypatch, hub, agent, placed_on_read=0)
    monkeypatch.setattr("flow_sdk.builtin.cloud_deploy.PLACED_WITHIN_S", 0)

    with pytest.raises(TimeoutError, match="placed no machine"):
        await run_cloud_deploy(CloudDeploy(agent, "user-1", "production", provider="e2b"), background=False)


async def test_a_second_deploy_of_the_same_agent_is_refused_while_one_runs(agent, hub):
    Activity.try_claim(DEPLOY_ACTIVITY, subject_entity=str(agent.typeid))

    with pytest.raises(DeployRunning):
        await run_cloud_deploy(CloudDeploy(agent, "user-1", "production", provider="e2b"), background=False)
    assert hub.deploys == []
