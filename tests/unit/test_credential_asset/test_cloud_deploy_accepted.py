"""A cloud deploy taken on (``agent_cloud_deploy.run_cloud_deploy``): everything up to readiness in the request,
the machine after the answer, each step a child of the agent's ``deploy`` activity; no model funding is a warning
in the answer, never a refusal; one deploy per agent at a time. The hub is the in-memory double. No network."""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.activity import Activity, ActivityState, monitor
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_cloud_deploy import DEPLOY_ACTIVITY, CloudDeploy, DeployRunning, run_cloud_deploy
from flow_sdk.schema.data_spec.agent_deploy_spec import ActivityAddress
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


async def test_an_unfunded_deploy_is_accepted_with_a_warning_and_still_placed(agent, hub):
    planned = await agent.plan_deployment("production", provider="e2b")
    hub.funding[str(planned.id)] = {"kind": "default", "name": "my default", "exhausted": EXHAUSTED}

    accepted = await run_cloud_deploy(CloudDeploy(agent, "user-1", "production", provider="e2b"), background=False)

    assert accepted.activity == ActivityAddress(path=DEPLOY_ACTIVITY, subject_entity=str(agent.typeid))
    assert accepted.deployment_id == str(planned.id)
    assert accepted.warnings == [
        f"No LLM funding for cloud-agent: {EXHAUSTED}: raise the limit (Configure) or wait for it to reset"
    ]
    assert hub.deploys == [{"environment": "production", "provider": "e2b", "require": []}], "funding never stops it"


async def test_a_background_deploy_answers_before_its_machine_is_placed(agent, hub, monkeypatch):
    release = asyncio.Event()

    async def slow_machine(entity, environment=None, *, provider=None, require=None):
        await release.wait()
        return {"deployment": {}}

    monkeypatch.setattr("flow_sdk.builtin.cloud_deploy.deploy_entity_to_cloud", slow_machine)
    ended: list[ActivityState] = []
    stop = monitor.subscribe(lambda root, transition: ended.append(root.state) if root.is_terminal else None)

    try:
        await run_cloud_deploy(CloudDeploy(agent, "user-1", "production", provider="e2b"), background=True)
        await asyncio.sleep(0)  # the detached machine step starts on the loop's next turn, then waits on the hub
        live = monitor.get(DEPLOY_ACTIVITY, subject_entity=str(agent.typeid))
        release.set()
        while not ended:
            await asyncio.sleep(0)
    finally:
        stop()

    assert [(c.name, c.state) for c in live.children] == [
        ("publish", ActivityState.COMPLETED),
        ("dependencies", ActivityState.COMPLETED),
        ("plan", ActivityState.COMPLETED),
        ("readiness", ActivityState.COMPLETED),
        ("machine", ActivityState.RUNNING),
    ]
    assert set(ended) == {ActivityState.COMPLETED}


async def test_a_second_deploy_of_the_same_agent_is_refused_while_one_runs(agent, hub):
    Activity.try_claim(DEPLOY_ACTIVITY, subject_entity=str(agent.typeid))

    with pytest.raises(DeployRunning):
        await run_cloud_deploy(CloudDeploy(agent, "user-1", "production", provider="e2b"), background=False)
    assert hub.deploys == []
