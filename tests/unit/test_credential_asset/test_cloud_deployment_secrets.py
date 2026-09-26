"""A cloud deployment keeps its values in the hub store; "use mine" copies this computer's values there;
the deploy is refused until the store holds what the agent needs; deleting a credential reaches the hub.
The hub is an in-memory double (``tests/utils/fake_hub_store``). No network."""
from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.credential_service import CredentialError, delete_credential, save_credential, use_mine
from flow_sdk.builtin.readiness import NotReady
from flow_sdk.schema.data_spec.requirement_spec import RequirementSpec
from flow_sdk.secrets import SecretStore
from tests.utils import fake_hub_store

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

VALUE = "sk-live-never-shown"


@pytest.fixture
def hub(monkeypatch):
    return fake_hub_store.install(monkeypatch)


async def _agent(project) -> Agent:
    agent = Agent(name="cloud-agent", project_id=str(project.id),
                  requirements=[RequirementSpec(kind="credential", name="stripe", vars=["STRIPE_KEY"])])
    await agent.save()
    return agent


async def _stripe_here(project) -> None:
    await save_credential(scope="project", project_id=str(project.id),
                          manifest={"name": "stripe", "vars": {"STRIPE_KEY": {}}, "setup": "x"}, values={"STRIPE_KEY": VALUE})


async def test_a_planned_cloud_deployment_keeps_its_values_in_the_hub_and_keeps_that_across_adoptions(home, project, hub):
    agent = await _agent(project)

    deployment = await agent.plan_deployment("production")
    again = await agent.plan_deployment("production")

    assert deployment.remote and deployment.secrets.store.type == "hub"
    assert again.id == deployment.id and again.secrets == deployment.secrets


async def test_the_hub_store_takes_values_lists_names_and_never_gives_one_back(home, project, hub):
    store = await SecretStore.get("hub", {"deployment_id": "d-1"})

    await store.save({"STRIPE_KEY": VALUE})
    await store.save({"STRIPE_KEY": VALUE + "-rotated"})

    assert await store.names() == ["STRIPE_KEY"] and hub.values["d-1"]["STRIPE_KEY"] == VALUE + "-rotated"
    assert await store.load(["STRIPE_KEY"]) == {}
    assert [c[0] for c in hub.calls if c[0] in ("POST", "PUT")] == ["POST", "PUT"]
    assert VALUE not in json.dumps(hub.calls), "only payload keys are ever recorded (and logged)"
    assert await store.forget(["STRIPE_KEY", "NEVER"]) == (["STRIPE_KEY"], [])


async def test_the_deploy_is_refused_until_use_mine_fills_the_store(home, project, hub, monkeypatch):
    agent = await _agent(project)
    await _stripe_here(project)
    monkeypatch.setattr(Agent, "ensure_on_hub", _published)  # publishing is the git path's; not under test here

    with pytest.raises(NotReady) as refused:
        await agent.deploy_to_cloud("user-1", "production")
    assert [i.requirement.name for i in refused.value.readiness.value_items(missing_only=True)] == ["stripe"]
    assert hub.deploys == [], "no machine is paid for"

    deployment = await agent.plan_deployment("production")
    assert await use_mine(str(deployment.id)) == {"copied": ["STRIPE_KEY"], "not_here": []}
    assert hub.values[str(deployment.id)] == {"STRIPE_KEY": VALUE}

    await agent.deploy_to_cloud("user-1", "production")
    assert hub.deploys == [{"environment": "production", "require": ["STRIPE_KEY"]}]


async def test_a_protected_deployment_refuses_use_mine(home, project, hub):
    agent = await _agent(project)
    await _stripe_here(project)
    deployment = await agent.plan_deployment("production")
    deployment.secrets = deployment.secrets.model_copy(update={"protected": True})
    await deployment.save()

    with pytest.raises(CredentialError, match="protected"):
        await use_mine(str(deployment.id))
    assert hub.values.get(str(deployment.id)) is None


async def test_deleting_a_credential_removes_its_value_from_the_hub_too(home, project, hub):
    agent = await _agent(project)
    await _stripe_here(project)
    deployment = await agent.plan_deployment("production")
    await use_mine(str(deployment.id))
    from flow_sdk.builtin.credential import Credential

    spec = await Credential.get("stripe", project)
    result = await delete_credential(str(spec.typeid))

    assert result.removed and hub.values[str(deployment.id)] == {}
    assert ("hub", ["STRIPE_KEY"]) in [(s.type, s.deleted) for s in result.stores]


async def _published(self, actor, force=False):
    return False
