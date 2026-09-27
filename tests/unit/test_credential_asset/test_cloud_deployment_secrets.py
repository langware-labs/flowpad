"""A cloud deployment keeps its values in the hub store; "use mine" copies this computer's values there;
the deploy is refused until the store holds what the agent needs; deleting a credential reaches the hub.
The hub is an in-memory double (``tests/utils/fake_hub_store``). No network."""
from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.credential_service import CredentialError, delete_credential, save_credential, use_mine
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.readiness import NotReady, readiness
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
    assert [(i.requirement.name, i.remedy) for i in refused.value.readiness.items if i.status == "missing"] == [
        ("stripe", "use_mine")
    ]
    assert hub.deploys == [], "no machine is paid for"

    deployment = await agent.plan_deployment("production")
    assert await use_mine(str(deployment.id)) == {"copied": ["STRIPE_KEY"], "not_here": [], "hub_funded": []}
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


async def test_an_oauth_need_on_a_cloud_deployment_needs_the_owners_authorization(home, project, hub, monkeypatch):
    from flow_sdk.builtin.readiness import readiness
    from flow_sdk.schema.data_spec.connection_spec import ConnectionSpec
    from tests.utils.connection_rows import fake_connections

    agent = Agent(name="cloud-slack", project_id=str(project.id),
                  requirements=[RequirementSpec(kind="connection", name="slack")])
    await agent.save()
    fake_connections(monkeypatch, {"slack": ConnectionSpec(provider="slack", display_name="Slack", connected=True)})
    deployment = await agent.plan_deployment("production")

    before = (await readiness(agent, deployment)).items
    assert [(i.status, i.fix) for i in before] == [("missing", "authorize slack for this deployment")]

    await deployment.authorize("slack", ["permission.slack.chat.write"])
    after = await readiness(agent, deployment)
    assert after.ready and after.items[0].status == "verified"


async def test_flow_credentials_diff_then_use_mine_closes_the_gap(home, project, hub, run_flow):
    agent = await _agent(project)
    await _stripe_here(project)
    deployment = str((await agent.plan_deployment("production")).id)
    diff = ("credentials", "diff", "here", deployment, "--project", str(project.id))

    before = json.loads((await run_flow(*diff)).stdout)
    copied = await run_flow("credentials", "use-mine", deployment, "--name", "STRIPE_KEY")
    after = json.loads((await run_flow(*diff)).stdout)

    assert [r["name"] for r in before["differ"]] == ["STRIPE_KEY"]
    assert before["differ"][0][deployment]["store"] == "hub"
    assert copied.exit_code == 0 and json.loads(copied.stdout)["copied"] == ["STRIPE_KEY"]
    assert VALUE not in copied.stdout + json.dumps(before) + json.dumps(after)
    assert after["differ"] == []


async def test_flow_credentials_check_and_set_take_a_deployment(home, project, hub, run_flow):
    agent = await _agent(project)
    await _stripe_here(project)
    deployment = str((await agent.plan_deployment("production")).id)
    check = ("credentials", "check", "stripe", "--project", str(project.id), "--deployment", deployment)

    missing = await run_flow(*check)
    set_ = await run_flow("credentials", "set", "stripe", "--stdin", "--project", str(project.id),
                          "--deployment", deployment, input=f"STRIPE_KEY={VALUE}\n")
    ready = await run_flow(*check)

    assert (missing.exit_code, ready.exit_code) == (1, 0), (missing.stdout, set_.stdout, ready.stdout)
    assert hub.values[deployment] == {"STRIPE_KEY": VALUE}
    assert VALUE not in set_.stdout


def _request(monkeypatch, body: dict):
    from unittest.mock import AsyncMock

    from flow_sdk.request_context.request_info import RequestInfo

    info = RequestInfo()
    info.get_post_data = AsyncMock(return_value=body)
    monkeypatch.setattr("flow_sdk.builtin.agent.get_current_request_info", lambda: info)
    monkeypatch.setattr("flow_sdk.request_context.methods.get_current_request_info", lambda: info)


async def test_the_deploy_dialog_plans_then_authorizes_and_revokes_over_rest(home, project, hub, monkeypatch):
    agent = await _agent(project)

    _request(monkeypatch, {"environment": "staging"})
    planned = (await agent.plan_deployment_action()).data
    deployment = await Deployment.get_by_id(planned["deployment"]["id"])
    _request(monkeypatch, {"provider": "google"})
    granted = await deployment.authorize_action()
    held = (await deployment.secrets_action()).data
    _request(monkeypatch, {"provider": "google", "revoke": True})
    revoked = (await deployment.authorize_action()).data
    _request(monkeypatch, {})
    refused = await deployment.authorize_action()

    assert planned["deployment"]["environment"] == "staging"
    assert [(i["requirement"]["name"], i["status"]) for i in planned["readiness"]["items"]] == [("stripe", "missing")]
    assert granted.status == "SUCCESS" and held["authorizations"] == [{"provider": "google"}]
    assert revoked == {"revoked": ["google"]} and hub.authorized[str(deployment.id)] == []
    assert refused.status_code == 400


async def test_use_mine_never_copies_an_llm_provider_key(home, project, hub):
    """A deployment is hub-funded: the key a laptop pays its own model calls with stays on the laptop."""
    agent = await _agent(project)
    await save_credential(scope="user", manifest={"name": "openrouter", "vars": {"OPENROUTER_API_KEY": {}},
                                                  "setup": "x", "lm_provider": "openrouter"},
                          values={"OPENROUTER_API_KEY": "sk-or-mine"})
    deployment = await agent.plan_deployment("production")

    result = await use_mine(str(deployment.id), ["OPENROUTER_API_KEY"])

    assert result == {"copied": [], "not_here": [], "hub_funded": ["OPENROUTER_API_KEY"]}
    assert "OPENROUTER_API_KEY" not in hub.values.get(str(deployment.id), {})


async def test_a_cloud_deployment_that_cannot_pay_for_a_turn_is_not_ready_and_says_which_limit(home, project, hub):
    agent = await _agent(project)
    await _stripe_here(project)
    deployment = await agent.plan_deployment("production")
    await use_mine(str(deployment.id))

    unknown = await readiness(agent, deployment)
    hub.funding[str(deployment.id)] = {"kind": "allocation", "name": "cloud-agent tokens", "exhausted": ""}
    funded = await readiness(agent, deployment)
    hub.funding[str(deployment.id)]["exhausted"] = "limit 'cost_usd_per_day' used up on cloud-agent tokens"
    spent = await readiness(agent, deployment)

    assert unknown.ready and not [i for i in unknown.items if i.requirement.kind == "funding"], "a hub that cannot say blocks nothing"
    (item,) = [i for i in funded.items if i.requirement.kind == "funding"]
    assert funded.ready and item.status == "verified" and item.where == "cloud-agent tokens (its token allocation)"
    (item,) = [i for i in spent.items if i.requirement.kind == "funding"]
    assert not spent.ready and item.status == "missing" and "cost_usd_per_day" in item.fix
    assert "funding" not in {r.kind for r in agent.requirements or []}, "asked at readiness, never written to the agent"
